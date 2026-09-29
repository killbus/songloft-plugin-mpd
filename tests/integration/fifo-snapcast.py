"""Linux integration using real MPD, FIFO and Snapcast; no private services."""
import array
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '_build/fifo-integration'
OUT.mkdir(parents=True, exist_ok=True)
processes, logs = [], []
report = {'passed': False, 'scope': 'system MPD / plugin config / FIFO / Snapcast', 'checks': []}

def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT, timeout=60).strip()

def start(name, *args):
    log = (OUT / (name + '.log')).open('wb')
    logs.append(log)
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    processes.append(proc)
    return proc

def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

def ready(port):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise AssertionError(f'Port {port} did not become ready')

def mpc(*args):
    return run('mpc', '-h', '127.0.0.1', '-p', '6600', *args)

def capture_tone(label, frequency):
    # Only new PCM can satisfy each recovery gate, never historical capture.
    pcm = OUT / 'received.pcm'
    offset = pcm.stat().st_size if pcm.exists() else 0
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        time.sleep(0.5)
        data = pcm.read_bytes()[offset:] if pcm.exists() else b''
        if len(data) < 88200:
            continue
        mono = array.array('h', data[-88200:])[::2]
        rms = math.sqrt(sum(x*x for x in mono) / len(mono))
        crossings = sum(a <= 0 < b for a, b in zip(mono, mono[1:]))
        measured = crossings * 44100 / len(mono)
        if rms > 100 and abs(measured - frequency) < 15:
            report['checks'].append({'name': label, 'rms': rms, 'frequency': measured})
            return
    raise AssertionError(f'{label}: no fresh {frequency} Hz PCM at Snapclient')

try:
    report['versions'] = {n: run(n, '--version') for n in ('mpd', 'snapserver', 'snapclient')}
    for frequency in (440, 880):
        run('ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
            f'sine=frequency={frequency}:sample_rate=44100:duration=90',
            '-ac', '2', '-c:a', 'aac', '-b:a', '128k', str(OUT / f'{frequency}.aac'))
    fifo = OUT / 'audio.fifo'
    os.mkfifo(fifo, 0o600)
    inode = fifo.stat().st_ino
    run('node', str(ROOT / 'tests/integration/generate-config.cjs'), str(OUT))
    (OUT / 'snapserver.conf').write_text(
        '[server]\nthreads = 2\n[http]\nenabled = false\n[tcp]\nenabled = false\n'
        '[stream]\nport = 1704\nbuffer = 500\n'
        f'source = pipe://{fifo}?name=Songloft&sampleformat=44100:16:2&codec=flac\n')
    http = start('http', 'python3', '-m', 'http.server', '18080', '--bind', '127.0.0.1', '--directory', str(OUT))
    ready(18080)
    server_args = ('snapserver', '-c', str(OUT / 'snapserver.conf'))
    server = start('snapserver', *server_args)
    ready(1704)
    client = start('snapclient', 'snapclient', '-h', '127.0.0.1', '--player',
                   'file:filename=' + str(OUT / 'received.pcm'), '--sampleformat', '44100:16:2')
    mpd_args = ('mpd', '--no-daemon', str(OUT / 'mpd.conf'))
    mpd = start('mpd', *mpd_args)
    ready(6600)
    mpc('clear')
    for frequency in (440, 880):
        mpc('add', f'http://127.0.0.1:18080/{frequency}.aac')
    mpc('volume', '100')
    mpc('play', '1')
    capture_tone('first-play', 440)
    mpc('pause', '1')
    assert '[paused]' in mpc('status')
    time.sleep(2)
    mpc('pause', '0')
    capture_tone('resume', 440)
    mpc('next')
    capture_tone('next-track', 880)
    stop(mpd)
    assert fifo.stat().st_ino == inode, 'MPD removed precreated FIFO'
    mpd = start('mpd-restart', *mpd_args)
    ready(6600)
    mpc('play', '2')
    capture_tone('mpd-restart', 880)
    stop(server)
    time.sleep(2)
    server = start('snapserver-restart', *server_args)
    ready(1704)
    capture_tone('snapserver-reconnect', 880)
    assert fifo.stat().st_ino == inode
    assert all(p.poll() is None for p in (mpd, server, client, http))
    report['fifoInodePreserved'] = True
    report['passed'] = True
finally:
    for proc in reversed(processes):
        stop(proc)
    for log in logs:
        log.close()
    (OUT / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
    for pattern in ('*.aac', '*.pcm'):
        for media in OUT.glob(pattern):
            media.unlink()
    if (OUT / 'audio.fifo').exists():
        (OUT / 'audio.fifo').unlink()
print(json.dumps(report, indent=2))
