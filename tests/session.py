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
    project = tempfile.mkdtemp(prefix="kflat-lsp-session-")
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

    send({"id": 2, "method": "textDocument/hover", "params": {}})
    expect("an unknown request is MethodNotFound",
           until(lambda m: m.get("id") == 2)["error"]["code"] == -32601)
    send({"id": 3, "method": "shutdown"})
    expect("shutdown answers null", until(lambda m: m.get("id") == 3)["result"] is None)
    send({"method": "exit"})
    expect("exit after shutdown exits 0", child.wait(timeout=10) == 0)


if __name__ == "__main__":
    main()
