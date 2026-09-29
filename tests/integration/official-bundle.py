"""Validate a pinned release bundle in the unchanged official Songloft image.

Runs the existing audio fixture via containerized MPD/MPC wrappers. This tests
runtime compatibility and plugin-generated configuration, not the UI installer.
Requires Linux, Docker, Node dependencies, ffmpeg, snapserver and snapclient.
"""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '_build/fifo-integration'
EXPECTED_SHA256 = '380b220c098e3c34b1f9b92ddff6e546fd52efc095b9b1173f47d106dae6d79f'
BUNDLE_URL = 'https://github.com/huaimi123/mympd/releases/download/v1.0.1/mpd-player-linux-x86_64-musl.tgz'


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=180).strip()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    archive = Path(sys.argv[1]).resolve()
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    evidence = {'scope': 'release bundle in official Songloft runtime / plugin config / FIFO / Snapcast',
                'bundleUrl': BUNDLE_URL, 'sha256': digest, 'passed': False}
    try:
        if digest != EXPECTED_SHA256:
            raise RuntimeError('Candidate asset changed: SHA256 mismatch')
        bundle = OUT / 'bundle'
        bundle.mkdir(exist_ok=False)
        with tarfile.open(archive) as package:
            evidence['archiveMembers'] = package.getnames()
            package.extractall(bundle, filter='data')
        for name in ('mpd', 'mpc'):
            if not (bundle / name).is_file():
                raise RuntimeError('Missing bundle launcher: ' + name)
        image = os.environ.get('SONGLOFT_TEST_IMAGE', 'songloft/songloft:latest')
        run('docker', 'pull', '--platform', 'linux/amd64', image)
        info = json.loads(run('docker', 'image', 'inspect', image))[0]
        evidence['image'] = {'requested': image, 'id': info['Id'], 'repoDigests': info['RepoDigests']}
        # Use the pulled immutable image ID throughout this run. No package installs.
        wrappers = OUT / 'wrappers'
        wrappers.mkdir()
        installed = '/app/data/jsplugins_data/mpd-player/bin'
        for name in ('mpd', 'mpc'):
            command = ['docker', 'run', '--rm', '--network', 'host', '--platform', 'linux/amd64',
                       '--mount', f'type=bind,src={OUT},dst={OUT}',
                       '--mount', f'type=bind,src={bundle},dst={installed},readonly',
                       '--entrypoint', '/bin/sh', info['Id'], f'{installed}/{name}']
            wrapper = wrappers / name
            wrapper.write_text('#!/bin/sh\nexec ' + shlex.join(command) + ' "$@"\n')
            wrapper.chmod(0o755)
        evidence['versions'] = {name: run(str(wrappers / name), '--version') for name in ('mpd', 'mpc')}
        os.environ['PATH'] = str(wrappers) + os.pathsep + os.environ['PATH']
        subprocess.run([sys.executable, str(ROOT / 'tests/integration/fifo-snapcast.py')], check=True)
        result_path = OUT / 'result.json'
        result = json.loads(result_path.read_text())
        result['scope'] = evidence['scope']
        result_path.write_text(json.dumps(result, indent=2) + '\n')
        evidence['passed'] = result['passed']
    except Exception as error:
        evidence['error'] = str(error)
        if isinstance(error, subprocess.CalledProcessError):
            evidence['commandOutput'] = error.output
        raise
    finally:
        (OUT / 'bundle-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
        print(json.dumps(evidence, indent=2))


if __name__ == '__main__':
    main()
