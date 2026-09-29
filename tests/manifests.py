#!/usr/bin/env python3
"""kf.toml and lint.toml in one editor session, end to end.

    tests/manifests.py SERVER

Builds a scratch package index and cache, opens a project's kf.toml and
lint.toml, and checks what completion, hover and inlay hints say about its
packages and lints. `KOMP_BIN` names the komp to use; it must know
`komp outdated` and `komp search --offline`.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile

ROW = 'source = { git = "file:///nowhere", rev = "0000000000000000000000000000000000000000" }\n'


def scratch_index(root):
    index = os.path.join(root, "index")
    os.makedirs(os.path.join(index, "js", "on"))
    with open(os.path.join(index, "config.toml"), "w") as config:
        config.write("schema = 1\n")
    with open(os.path.join(index, "js", "on", "json.toml"), "w") as entry:
        entry.write('schema = 1\nname = "json"\ndescription = "JSON reading and writing"\n')
        for version, yanked in [("0.1.0", False), ("0.2.0", False), ("0.2.1", True)]:
            entry.write('\n[[version]]\nversion = "%s"\n%s' % (version, ROW))
            if yanked:
                entry.write("yanked = true\n")
    git = ["git", "-C", index, "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", index], check=True)
    subprocess.run(git + ["add", "."], check=True)
    subprocess.run(git + ["commit", "-qm", "index"], check=True)
    return "file://" + index


def main():
    server = os.path.realpath(sys.argv[1])
    komp = os.environ.get("KOMP_BIN", "komp")
    root = os.path.realpath(tempfile.mkdtemp(prefix="komp-lsp-manifests-"))
    os.environ["KFLAT_CACHE"] = os.path.join(root, "cache")
    os.environ["KFLAT_INDEX"] = scratch_index(root)
    subprocess.run([komp, "search"], check=True, stdout=subprocess.DEVNULL)

    project = os.path.join(root, "app")
    os.makedirs(os.path.join(project, "src"))
    manifest = '[project]\nname = "app"\nversion = "0.1.0"\nkind = "bin"\n\n[dependencies]\njson = "0.1"\n'
    with open(os.path.join(project, "kf.toml"), "w") as out:
        out.write(manifest)
    with open(os.path.join(project, "kf.lock"), "w") as out:
        out.write('schema = 1\n\n[[package]]\nname = "json"\nversion = "0.1.0"\n%sindex = "%s"\n'
                  % (ROW, os.environ["KFLAT_INDEX"]))
    with open(os.path.join(project, "src", "main.kf"), "w") as out:
        out.write("fun main(): int32 {\n    return 0\n}\n")
    lints = '[lints]\nlong_line = "deny"\n'
    with open(os.path.join(project, "lint.toml"), "w") as out:
        out.write(lints)
    manifest_uri = "file://" + project + "/kf.toml"
    lints_uri = "file://" + project + "/lint.toml"

    child = subprocess.Popen([server], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    signal.alarm(120)

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

    next_id = [100]

    def ask(method, params):
        next_id[0] += 1
        send({"id": next_id[0], "method": method, "params": params})
        while True:
            message = receive()
            if message.get("id") == next_id[0]:
                return message["result"]

    def next_diagnostics(uri, holds=lambda diagnostics: True):
        while True:
            message = receive()
            params = message.get("params") or {}
            if message.get("method") == "textDocument/publishDiagnostics" and params["uri"] == uri \
                    and holds(params["diagnostics"]):
                return params["diagnostics"]

    def expect(what, holds):
        print(("PASS  " if holds else "FAIL  ") + what)
        if not holds:
            sys.exit(1)

    def open_document(uri, text, version=1):
        send({"method": "textDocument/didOpen",
              "params": {"textDocument": {"uri": uri, "languageId": "toml", "version": version, "text": text}}})

    def at(uri, line, character):
        return {"textDocument": {"uri": uri}, "position": {"line": line, "character": character}}

    ask("initialize", {"rootUri": "file://" + project, "capabilities": {}})
    send({"method": "initialized", "params": {}})

    open_document(manifest_uri, manifest + "js")
    items = ask("textDocument/completion", at(manifest_uri, 7, 2))["items"]
    expect("a dependency's name completes from the index",
           [(i["label"], i["detail"]) for i in items] == [("json", "0.2.0")])

    open_document(manifest_uri, manifest.replace('"0.1"', '"'), 2)
    items = ask("textDocument/completion", at(manifest_uri, 6, 8))["items"]
    expect("versions complete newest first, the yanked one left out",
           [i["label"] for i in items] == ["0.2.0", "0.1.0"] and items[0]["textEdit"]["newText"] == "0.2.0")

    open_document(manifest_uri, manifest, 3)
    hover = ask("textDocument/hover", at(manifest_uri, 6, 1))
    value = hover["contents"]["value"] if hover else ""
    expect("hover on a dependency names its versions",
           "JSON reading and writing" in value and "locked 0.1.0" in value and "newest 0.2.0" in value)
    hints = ask("textDocument/inlayHint", {"textDocument": {"uri": manifest_uri},
                                           "range": {"start": {"line": 0, "character": 0},
                                                     "end": {"line": 9, "character": 0}}})
    expect("a locked dependency's hint names the newer release",
           [h["label"] for h in hints] == ["locked 0.1.0, 0.2.0 available"]
           and hints[0]["position"] == {"line": 6, "character": 12})

    open_document(lints_uri, lints + "lo")
    labels = [i["label"] for i in ask("textDocument/completion", at(lints_uri, 2, 2))["items"]]
    expect("a lint name completes under [lints]", "long_line" in labels and "long_file" in labels)
    open_document(lints_uri, lints + 'long_file = "', 2)
    labels = [i["label"] for i in ask("textDocument/completion", at(lints_uri, 2, 13))["items"]]
    expect("a lint's level completes", labels == ["allow", "warn", "deny"])
    open_document(lints_uri, lints + "long_file = { ", 3)
    labels = [i["label"] for i in ask("textDocument/completion", at(lints_uri, 2, 14))["items"]]
    expect("an inline table offers the level and the lint's options", labels == ["level", "max_lines"])
    open_document(lints_uri, lints, 4)
    hover = ask("textDocument/hover", at(lints_uri, 1, 3))
    expect("hover on a lint gives its level and options",
           hover is not None and "deny here" in hover["contents"]["value"]
           and "max_columns" in hover["contents"]["value"])

    open_document(manifest_uri, manifest, 5)
    diagnostics = next_diagnostics(manifest_uri)
    by_severity = {d["severity"]: d for d in diagnostics}
    expect("a locked version missing from the cache is information on the name",
           by_severity.get(3, {}).get("range", {}).get("start") == {"line": 6, "character": 0})
    expect("a newer release outside the requirement is a hint on the requirement",
           by_severity.get(4, {}).get("range") == {"start": {"line": 6, "character": 8},
                                                  "end": {"line": 6, "character": 11}})
    actions = ask("textDocument/codeAction", {"textDocument": {"uri": manifest_uri},
                                              "range": {"start": {"line": 6, "character": 9},
                                                        "end": {"line": 6, "character": 9}},
                                              "context": {"diagnostics": []}})
    edits = [a["edit"]["changes"][manifest_uri][0]["newText"] for a in actions]
    expect("the hint's quick fix raises the requirement", [a["title"] for a in actions] == ['Require "0.2"']
           and edits == ["0.2"])
    lenses = ask("textDocument/codeLens", {"textDocument": {"uri": manifest_uri}})
    expect("Fetch and Update all sit above [dependencies]",
           [(l["command"]["title"], l["command"]["command"], l["range"]["start"]["line"]) for l in lenses]
           == [("Fetch", "komp.fetch", 5), ("Update all", "komp.update", 5)])
    ask("workspace/executeCommand", lenses[0]["command"])
    failed = next_diagnostics(manifest_uri, lambda found: any("fetching failed" in d["message"] for d in found))
    expect("a failed fetch is an error on the manifest", any(d["severity"] == 1 for d in failed))

    ask("shutdown", None)
    send({"method": "exit"})
    expect("the server exits cleanly after shutdown", child.wait(timeout=10) == 0)


if __name__ == "__main__":
    main()
