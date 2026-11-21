"""Make an ephemeral trust root for testing the packaged app in an isolated directory."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

source, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)
payload = output / "package"
if source.is_dir():
    subprocess.run(["tar", "-czf", str(payload), "-C", str(source.parent), source.name],
                   env={**os.environ, "COPYFILE_DISABLE": "1"}, check=True)
else:
    shutil.copyfile(source, payload)
cli = ["node", "node_modules/@tauri-apps/cli/tauri.js", "signer"]
with tempfile.TemporaryDirectory() as private:
    key = Path(private, "key")
    subprocess.run([*cli, "generate", "--ci", "-p", "", "-w", str(key)],
                   stdout=subprocess.DEVNULL, check=True)
    shutil.copyfile(str(key) + ".pub", output / "public.key")
    subprocess.run([*cli, "sign", "-f", str(key), "-p", "", "--app-version", "99.0.0", str(payload)],
                   stdout=subprocess.DEVNULL, check=True)
