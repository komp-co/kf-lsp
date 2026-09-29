#!/usr/bin/env python3
"""One editor session against the built server, end to end.

    tests/session.py SERVER

Opens a file with a type error in a scratch project, checks that the error is
published where it is, types a fix in three quick edits, and checks that one
debounced check clears it. `KOMP_BIN` names the komp to use.
"""
import json
import os
import subprocess
import sys
import tempfile


def main():
    server = os.path.realpath(sys.argv[1])
    project = tempfile.mkdtemp(prefix="komp-lsp-session-")
    os.makedirs(os.path.join(project, "src"))
    with open(os.path.join(project, "kf.toml"), "w") as manifest:
        manifest.write('[project]\nname = "session"\nversion = "0.1.0"\nkind = "bin"\n')
    with open(os.path.join(project, "src", "main.kf"), "w") as source:
        source.write("fun main(): int32 {\n    return 0\n}\n")
    uri = "file://" + os.path.realpath(project) + "/src/main.kf"

    child = subprocess.Popen([server], stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    def send(message):
        body = json.dumps(dict(jsonrpc="2.0", **message)).encode()
        child.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
        child.stdin.flush()

    def receive():
        length = None
        while True:
            line = child.stdout.readline()
            if not line:
                sys.exit("the server closed its output")
            line = line.strip()
            if not line:
                break
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":")[1])
        return json.loads(child.stdout.read(length))

    def until(accept):
        while True:
            message = receive()
            if message.get("method") == "window/logMessage":
                print("  log:", message["params"]["message"])
            if accept(message):
                return message

    def expect(what, holds):
        print(("PASS  " if holds else "FAIL  ") + what)
        if not holds:
            sys.exit(1)

    send({"id": 1, "method": "initialize",
          "params": {"rootUri": "file://" + os.path.realpath(project), "capabilities": {}}})
    answer = until(lambda m: m.get("id") == 1)
    expect("initialize names full-document sync",
           answer["result"]["capabilities"]["textDocumentSync"]["change"] == 1)
    send({"method": "initialized", "params": {}})

    broken = 'fun main(): int32 {\n    val x: int32 = "text"\n    return x\n}\n'
    send({"method": "textDocument/didOpen",
          "params": {"textDocument": {"uri": uri, "languageId": "kflat", "version": 1, "text": broken}}})
    published = until(lambda m: m.get("method") == "textDocument/publishDiagnostics")["params"]
    found = published["diagnostics"]
    expect("an open file's error is published",
           published["uri"] == uri and len(found) == 1 and found[0]["severity"] == 1)
    expect("the range covers the string literal",
           found[0]["range"] == {"start": {"line": 1, "character": 19}, "end": {"line": 1, "character": 25}})

    fixed = "fun main(): int32 {\n    val x: int32 = 4\n    return x\n}\n"
    for version, text in enumerate([fixed[:24], fixed[:36], fixed], start=2):
        send({"method": "textDocument/didChange",
              "params": {"textDocument": {"uri": uri, "version": version}, "contentChanges": [{"text": text}]}})
    published = until(lambda m: m.get("method") == "textDocument/publishDiagnostics")["params"]
    expect("typing is checked once, from the unsaved text", published["diagnostics"] == [])

    document = {"textDocument": {"uri": uri}}
    send({"id": 10, "method": "textDocument/documentSymbol", "params": document})
    symbols = until(lambda m: m.get("id") == 10)["result"]
    expect("the outline names main, from the unsaved text",
           [s["name"] for s in symbols] == ["main"] and symbols[0]["range"]["end"] == {"line": 3, "character": 1})
    send({"id": 11, "method": "textDocument/foldingRange", "params": document})
    expect("main folds from its first line to its last",
           until(lambda m: m.get("id") == 11)["result"] == [{"startLine": 0, "endLine": 3, "kind": "region"}])
    send({"id": 12, "method": "textDocument/selectionRange",
          "params": {"textDocument": {"uri": uri}, "positions": [{"line": 1, "character": 19}]}})
    chain = until(lambda m: m.get("id") == 12)["result"][0]
    expect("selection grows from the literal to the declaration",
           chain["range"]["start"] == {"line": 1, "character": 19} and chain["parent"]["range"]["start"] == {"line": 0, "character": 0})

    send({"id": 13, "method": "textDocument/hover",
          "params": {"textDocument": {"uri": uri}, "position": {"line": 2, "character": 11}}})
    hover = until(lambda m: m.get("id") == 13)["result"]
    expect("hover names a local's type",
           hover["contents"]["value"] == "```kflat\nint32\n```" and hover["range"]["start"] == {"line": 2, "character": 11})
    edited = "fun twice(n: int32): int32 {\n    return n * 2\n}\n\nfun main(): int32 {\n    return twice(4)\n}\n"
    send({"method": "textDocument/didChange",
          "params": {"textDocument": {"uri": uri, "version": 9}, "contentChanges": [{"text": edited}]}})
    send({"id": 14, "method": "textDocument/hover",
          "params": {"textDocument": {"uri": uri}, "position": {"line": 5, "character": 12}}})
    hover = until(lambda m: m.get("id") == 14)["result"]
    expect("an edit is seen by the next hover", "twice(n: int32): int32" in hover["contents"]["value"])
    at_call = {"textDocument": {"uri": uri}, "position": {"line": 5, "character": 12}}
    send({"id": 15, "method": "textDocument/definition", "params": at_call})
    definition = until(lambda m: m.get("id") == 15)["result"]
    expect("a call goes to its declaration",
           definition == {"uri": uri, "range": {"start": {"line": 0, "character": 4}, "end": {"line": 0, "character": 9}}})
    send({"id": 16, "method": "textDocument/references", "params": dict(at_call, context={"includeDeclaration": False})})
    uses = until(lambda m: m.get("id") == 16)["result"]
    expect("references are the uses",
           [u["range"]["start"] for u in uses] == [{"line": 5, "character": 11}])
    send({"id": 17, "method": "textDocument/signatureHelp",
          "params": {"textDocument": {"uri": uri}, "position": {"line": 5, "character": 17}}})
    help = until(lambda m: m.get("id") == 17)["result"]
    expect("signature help names the callee and its parameter",
           help["signatures"][0]["label"] == "twice(n: int32): int32" and help["activeParameter"] == 0)

    named = ("fun twice(n: int32): int32 {\n    return n * 2\n}\n\n"
             "fun main(): int32 {\n    val four = twice(2)\n    return twice(four)\n}\n")
    send({"method": "textDocument/didChange",
          "params": {"textDocument": {"uri": uri, "version": 10}, "contentChanges": [{"text": named}]}})
    send({"id": 18, "method": "textDocument/inlayHint",
          "params": {"textDocument": {"uri": uri},
                     "range": {"start": {"line": 0, "character": 0}, "end": {"line": 8, "character": 0}}}})
    hints = until(lambda m: m.get("id") == 18)["result"]
    expect("an unannotated binding gets its type as a hint",
           hints == [{"position": {"line": 5, "character": 12}, "label": ": int32", "kind": 1}])
    send({"id": 19, "method": "textDocument/semanticTokens/full", "params": document})
    data = until(lambda m: m.get("id") == 19)["result"]["data"]
    expect("the first token is twice, a function", data[:5] == [0, 4, 5, 1, 0])
    at_use = {"textDocument": {"uri": uri}, "position": {"line": 6, "character": 11}}
    send({"id": 20, "method": "textDocument/completion", "params": at_use})
    labels = [i["label"] for i in until(lambda m: m.get("id") == 20)["result"]["items"]]
    expect("completion offers the local and the function", "four" in labels and "twice" in labels)
    send({"id": 21, "method": "textDocument/prepareRename", "params": at_use})
    expect("prepare-rename answers the name under the cursor",
           until(lambda m: m.get("id") == 21)["result"]
           == {"start": {"line": 6, "character": 11}, "end": {"line": 6, "character": 16}})
    send({"id": 22, "method": "textDocument/rename", "params": dict(at_use, newName="double")})
    changes = until(lambda m: m.get("id") == 22)["result"]["changes"]
    expect("a rename edits the declaration and both calls",
           list(changes) == [uri] and len(changes[uri]) == 3
           and all(edit["newText"] == "double" for edit in changes[uri]))
    send({"id": 23, "method": "textDocument/rename", "params": dict(at_use, newName="main")})
    refusal = until(lambda m: m.get("id") == 23)["error"]
    expect("a rename onto a taken name is refused with the reason",
           refusal["code"] == -32803 and "main" in refusal["message"])

    misspelt = ("struct Point {\n    val x: int32\n}\n\nfun Point.sum(): int32 {\n    return self.x\n}\n\n"
                "fun main(): int32 {\n    val p = Point { x: 1 }\n    return p.sunm()\n}\n")
    send({"method": "textDocument/didChange",
          "params": {"textDocument": {"uri": uri, "version": 11}, "contentChanges": [{"text": misspelt}]}})
    published = until(lambda m: m.get("method") == "textDocument/publishDiagnostics")["params"]
    expect("a misspelt method is reported", len(published["diagnostics"]) == 1)
    cursor = {"start": {"line": 10, "character": 4}, "end": {"line": 10, "character": 4}}
    send({"id": 24, "method": "textDocument/codeAction",
          "params": {"textDocument": {"uri": uri}, "range": cursor, "context": {"diagnostics": []}}})
    actions = until(lambda m: m.get("id") == 24)["result"]
    edit = actions[0]["edit"]["changes"][uri][0] if actions else {}
    expect("the compiler's fix is offered on the line",
           len(actions) == 1 and actions[0]["title"] == "change to `sum`" and edit["newText"] == "sum"
           and edit["range"] == {"start": {"line": 10, "character": 13}, "end": {"line": 10, "character": 17}})

    send({"id": 2, "method": "textDocument/linkedEditingRange", "params": {}})
    expect("an unknown request is MethodNotFound",
           until(lambda m: m.get("id") == 2)["error"]["code"] == -32601)
    send({"id": 3, "method": "shutdown"})
    expect("shutdown answers null", until(lambda m: m.get("id") == 3)["result"] is None)
    send({"method": "exit"})
    expect("exit after shutdown exits 0", child.wait(timeout=10) == 0)


if __name__ == "__main__":
    main()
