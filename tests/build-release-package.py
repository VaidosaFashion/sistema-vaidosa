"""Empacota somente arquivos já preparados; não publica nem executa SQL."""
from pathlib import Path
import hashlib
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
output = root.parent / 'vaidosa-instalacao-2026-11-04'
output.mkdir(exist_ok=True)
revision = subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()
branch = subprocess.check_output(['git','branch','--show-current'], cwd=root, text=True).strip()
files = {
    'LEIA-ME.md': root/'docs/LEIA-ME-INSTALACAO.md',
    '01_preflight.sql': root/'docs/deploy-preflight.sql',
    '02_instalar_transacao.sql': root/'supabase/releases/20261104_install_sales.sql',
    '03_pos_instalacao.sql': root/'docs/deploy-postcheck.sql',
    'RELATORIO.md': root/'docs/auditoria-manual-concluida-2026-11-04.md',
    'frontend/index.html': root/'index.html',
    'frontend/financial-corrections.js': root/'financial-corrections.js',
    'previa-offline.html': root.parent/'vaidosa-previa.html',
}
for dest, source in files.items():
    target = output/dest
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(source,target)
patch = subprocess.check_output(['git','diff','--binary','ee4b5e8',revision],cwd=root)
(output/'codigo-fonte.patch').write_bytes(patch)
(root.parent/'vaidosa-correcoes.patch').write_bytes(patch)
(output/'REVISAO.txt').write_text(
    f'Commit: {revision}\nBranch: {branch}\nBase: ee4b5e8\n'
    'Estado: não publicado; banco remoto não alterado\n'
    'Backup real: NÃO VERIFICADO; aplicação pendente\n'
    'Interface: 39/39 testes passaram\n'
    'SQL: instalador transacional + schema observado + cinco cenários concorrentes passaram\n'
)
paths = sorted(p for p in output.rglob('*') if p.is_file() and p.name!='SHA256SUMS.txt')
(output/'SHA256SUMS.txt').write_text(''.join(
    f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(output).as_posix()}\n' for p in paths))
archive = output.with_suffix('.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in sorted(output.rglob('*')):
        if p.is_file(): z.write(p,p.relative_to(output.parent))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
print(f'{archive}\nSHA256 {hashlib.sha256(archive.read_bytes()).hexdigest()}\n{revision}\n{branch}')
