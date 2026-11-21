"""Prepare the GitHub release feed from the artifacts tested on both runners."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib

DEST = Path("release-assets")
PACKAGES = {"windows-x86_64": "LedgerView.exe", "darwin-aarch64": "LedgerView.app.tar.gz"}
MAC_DOWNLOAD = "LedgerView-macOS-arm64.app.zip"


def release_version(config):
    tag = os.environ["GITHUB_REF_NAME"]
    versions = [
        config["version"],
        json.loads(Path("package.json").read_text())["version"],
        tomllib.loads(Path("src-tauri/Cargo.toml").read_text())["package"]["version"],
    ]
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", tag) or any(v != tag for v in versions):
        raise ValueError("The numeric release tag must match the desktop, Rust and frontend versions")
    return tag


def fetch(repo):
    run = os.environ["GITHUB_RUN_ID"]
    metadata = json.loads(subprocess.check_output(["gh", "api", f"repos/{repo}/actions/runs/{run}/artifacts"]))
    artifacts = {item["name"]: item for item in metadata["artifacts"]}
    DEST.mkdir()
    for name in [*PACKAGES.values(), MAC_DOWNLOAD]:
        item = artifacts[name]
        path = DEST / name
        with path.open("wb") as output:
            subprocess.run(["gh", "api", f"repos/{repo}/actions/artifacts/{item['id']}/zip"], stdout=output, check=True)
        with path.open("rb") as downloaded:
            digest = hashlib.file_digest(downloaded, "sha256").hexdigest()
        if item["expired"] or item["digest"] != "sha256:" + digest:
            raise ValueError(f"Invalid CI artifact: {name}")


def sign(config, repo, version):
    platforms = {}
    with tempfile.TemporaryDirectory() as tmp:
        pub = Path(tmp, "public.key")
        pub.write_bytes(base64.b64decode(config["plugins"]["updater"]["pubkey"], validate=True))
        for target, name in PACKAGES.items():
            path = DEST / name
            subprocess.run(["node_modules/.bin/tauri", "signer", "sign", "--app-version", version, str(path)], check=True)
            signature = Path(str(path) + ".sig").read_text().strip()
            decoded = Path(tmp, "artifact.minisig")
            decoded.write_bytes(base64.b64decode(signature, validate=True))
            # Verify against the public key embedded in the app before publishing.
            subprocess.run(["minisign", "-V", "-l", "-m", str(path), "-p", str(pub), "-x", str(decoded)], check=True)
            platforms[target] = {"signature": signature, "url": f"https://github.com/{repo}/releases/download/{version}/{name}"}
    (DEST / "latest.json").write_text(json.dumps({"version": version, "platforms": platforms}, indent=2) + "\n")


if __name__ == "__main__":
    config = json.loads(Path("src-tauri/tauri.conf.json").read_text())
    version = release_version(config)
    repo = os.environ["GITHUB_REPOSITORY"]
    if sys.argv[1:] == ["fetch"]:
        fetch(repo)
    elif sys.argv[1:] == ["sign"]:
        sign(config, repo, version)
    else:
        raise SystemExit("Expected fetch or sign")
