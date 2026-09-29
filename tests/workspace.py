#!/usr/bin/env python3
"""A two-crate workspace in one editor session.

    tests/workspace.py SERVER

`app` calls `area` from `geometry`. Renaming it in geometry and saving
publishes the broken call in app, which is not being edited; renaming it
back and saving clears it. `KOMP_BIN` names the komp to use.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile

LIBRARY = "pub fun area(w: int32, h: int32): int32 {\n    return w * h\n}\n"


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as out:
        out.write(text)


def main():
    server = os.path.realpath(sys.argv[1])
    root = os.path.realpath(tempfile.mkdtemp(prefix="komp-lsp-workspace-"))
    write(os.path.join(root, "kf.toml"), '[workspace]\nmembers = ["app", "geometry"]\ndefault-member = "app"\n')
    write(os.path.join(root, "geometry", "kf.toml"), '[project]\nname = "geometry"\nversion = "0.1.0"\nkind = "lib"\n')
    library = os.path.join(root, "geometry", "src", "lib.kf")
    write(library, LIBRARY)
    write(os.path.join(root, "app", "kf.toml"), '[project]\nname = "app"\nversion = "0.1.0"\nkind = "bin"\n\n'
          '[dependencies]\ngeometry = { path = "../geometry" }\n')
    program = "import geometry.area\n\nfun main(): int32 {\n    return area(2, 3)\n}\n"
    write(os.path.join(root, "app", "src", "main.kf"), program)
    library_uri = "file://" + library
    program_uri = "file://" + os.path.join(root, "app", "src", "main.kf")

    child = subprocess.Popen([server], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    signal.alarm(180)

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

    def diagnostics_of(uri):
        while True:
            message = receive()
            if message.get("method") == "textDocument/publishDiagnostics" and message["params"]["uri"] == uri:
                return message["params"]["diagnostics"]

    def expect(what, holds):
        print(("PASS  " if holds else "FAIL  ") + what)
        if not holds:
            sys.exit(1)

    def save_library(text, version):
        write(library, text)
        send({"method": "textDocument/didChange",
              "params": {"textDocument": {"uri": library_uri, "version": version}, "contentChanges": [{"text": text}]}})
        send({"method": "textDocument/didSave", "params": {"textDocument": {"uri": library_uri}}})

    send({"id": 1, "method": "initialize", "params": {"rootUri": "file://" + root, "capabilities": {}}})
    while receive().get("id") != 1:
        pass
    send({"method": "initialized", "params": {}})
    for uri, text in [(program_uri, program), (library_uri, LIBRARY)]:
        send({"method": "textDocument/didOpen",
              "params": {"textDocument": {"uri": uri, "languageId": "kflat", "version": 1, "text": text}}})

    save_library(LIBRARY.replace("area", "surface"), 2)
    broken = diagnostics_of(program_uri)
    expect("renaming a library function and saving breaks its caller in another crate",
           len(broken) > 0 and broken[0]["severity"] == 1)

    save_library(LIBRARY, 3)
    expect("renaming it back and saving clears the caller", diagnostics_of(program_uri) == [])

    send({"id": 2, "method": "shutdown"})
    while receive().get("id") != 2:
        pass
    send({"method": "exit"})
    expect("the server exits cleanly after shutdown", child.wait(timeout=10) == 0)


if __name__ == "__main__":
    main()
