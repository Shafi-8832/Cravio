"""Produce complete copy/paste source files and a clean ZIP; never include secrets."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'deliverables'
OUT.mkdir(exist_ok=True)
EXCLUDED = {'.git', 'node_modules', 'dist', 'deliverables', '.claude', '.postman', 'postman', '.codex', '.agents', '__pycache__'}
TEXT = {'.js', '.jsx', '.css', '.html', '.json', '.sql', '.md', '.py', '.svg', '.txt'}

def include(path):
    relative = path.relative_to(ROOT)
    if any(part in EXCLUDED for part in relative.parts):
        return False
    if path.name in {'.DS_Store', 'hard_log_out'} or (path.name.startswith('.env') and path.name != '.env.example'):
        return False
    return path.is_file()

files = sorted(path for path in ROOT.rglob('*') if include(path))
manifest = []
with zipfile.ZipFile(OUT / 'Cravio-complete-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in files:
        relative = path.relative_to(ROOT).as_posix()
        archive.write(path, f'Cravio/{relative}')
        manifest.append({'path': relative, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})

with (OUT / 'COPY_PASTE_FILES.md').open('w') as output:
    output.write('# Cravio — complete copy/paste files\n\nStart with `docs/SETUP.md`. Back up your project, then create or replace each matching file below. '
                 'The ZIP is easier: it also contains the binary food photos. Secrets and installed dependencies are excluded. '
                 'Never run schema.sql over your existing database; use `npm run db:migrate`.\n\n')
    for path in files:
        if (path.suffix not in TEXT and path.name != '.env.example') or path.name.endswith('lock.json') or path.suffix == '.svg' or path.name == 'COPY_PASTE_FILES.md':
            continue
        if path.name in {'CLAUDE.md'} or path.relative_to(ROOT).parts[0] == 'postman':
            continue
        relative = path.relative_to(ROOT).as_posix()
        language = {'.js': 'javascript', '.jsx': 'jsx', '.py': 'python', '.md': 'markdown'}.get(path.suffix, path.suffix[1:])
        output.write(f'## `{relative}`\n\nCreate or replace this file with:\n\n````{language}\n{path.read_text()}\n````\n\n')
(OUT / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Packaged {len(files)} files. ZIP, copy/paste guide, and checksum manifest are in deliverables/.')
