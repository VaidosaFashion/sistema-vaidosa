"""Empacota a revisão integrada local; não publica, exporta dados nem executa SQL."""
from pathlib import Path
import hashlib
import re
import shutil
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
assert not subprocess.check_output(['git','status','--porcelain'], cwd=root, text=True).strip(), \
    'Committar a revisão completa e manter o checkout limpo antes de empacotar.'
output = root.parent / 'vaidosa-financeiro-integrado-2026-11-04'
output.mkdir(exist_ok=True)
revision = subprocess.check_output(['git','rev-parse','HEAD'], cwd=root, text=True).strip()
branch = subprocess.check_output(['git','branch','--show-current'], cwd=root, text=True).strip()
base = '931b28c2078c69cec617d5d0b6087c56fd393e99'
files = {
    'LEIA-ME.md': root/'docs/LEIA-ME-INSTALACAO.md',
    'ROTEIRO-CHECKPOINT.md': root/'docs/ROTEIRO-CHECKPOINT.md',
    'BACKUP-ALTERNATIVAS.md': root/'docs/backup-restauravel-financeiro.md',
    'PERSISTENCIA-CARRINHO.md': root/'docs/persistencia-carrinho.md',
    '00_checkpoint_somente_leitura.sql': root/'docs/checkpoint-financeiro-readonly.sql',
    '00_validar_checkpoint.py': root/'tests/verify-financial-checkpoint.py',
    '01_preflight.sql': root/'docs/deploy-preflight.sql',
    '02_instalar_transacao.sql': root/'supabase/releases/20261104_install_sales.sql',
    '03_pos_instalacao.sql': root/'docs/deploy-postcheck.sql',
    'RELATORIO-AUDITORIA-ORIGINAL.md': root/'docs/auditoria-manual-concluida-2026-11-04.md',
    'RELATORIO-INTEGRACAO.md': root/'docs/financial-integration-2026-11-04.md',
    'evidencias/interface.txt': root/'docs/financial-integration-test-results.txt',
    'evidencias/postgresql.txt': root/'docs/financial-integration-sql-results.txt',
    'evidencias/verificador.txt': root/'docs/financial-checkpoint-verifier-tests.txt',
    'previa-financeira-offline.html': root.parent/'vaidosa-previa.html',
}
for name in ['index.html','financial-corrections.js','cart-draft-store.js','cart-draft-ui.js','cart-draft-app.js']:
    files['frontend/'+name]=root/name
# Lista fechada: nunca copiar CSV/exportações/dados reais para o pacote.
for dest, source in files.items():
    target=output/dest; target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
ui=(root/'docs/financial-integration-test-results.txt').read_text()
assert re.search(r'\btests 108\b',ui) and re.search(r'\bpass 108\b',ui) and re.search(r'\bfail 0\b',ui)
sql=(root/'docs/financial-integration-sql-results.txt').read_text()
assert 'PASS: todas as migrações e consultas de auditoria' in sql
assert 'checkpoint recupera valores/tipos' in sql and 'cinco definicoes originais' in sql
patch=subprocess.check_output(['git','diff','--binary',base,revision],cwd=root)
(output/'integracao-sobre-931b28c.patch').write_bytes(patch)
(output/'REVISAO.txt').write_text(
    f'Commit: {revision}\nBranch: {branch}\nBase publicada: {base}\nFinanceiro auditado: f8651f39322f9dbc17c2dd1e025a17d80c74ad37\n'
    'Estado: somente local; financeiro NÃO publicado nem aplicado\n'
    'Produção: SEM backup completo/checkpoint real validado nesta entrega\n'
    'Recuperação: limitada, exige aceite explícito, exportação real privada e conferência\n'
    'Interface: 108/108 testes passaram\n'
    'PostgreSQL: instalador/schema observado, cinco cenários concorrentes e roundtrip limitado de checkpoint passaram\n'
    'Nenhuma venda real, credencial ou dump é incluído\n')
paths=sorted(output/dest for dest in list(files)+['integracao-sobre-931b28c.patch','REVISAO.txt'])
manifest=output/'SHA256SUMS.txt'
manifest.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(output).as_posix()}\n' for p in paths))
archive=output.with_suffix('.zip')
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in paths+[manifest]:z.write(p,p.relative_to(output.parent))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert z.read(output.name+'/frontend/index.html')==(root/'index.html').read_bytes()
print(f'{archive}\nSHA256 {hashlib.sha256(archive.read_bytes()).hexdigest()}\n{revision}\n{branch}')
