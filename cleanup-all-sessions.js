// Script para limpar TODAS as sessões antigas
const path = require('path');
const fs = require('fs');

console.log('\n=== LIMPEZA COMPLETA DE TODAS AS SESSÕES ===\n');

const authPath = path.join(__dirname, '.wwebjs_auth');

if (!fs.existsSync(authPath)) {
    console.log('✓ Pasta .wwebjs_auth não existe. Nada para limpar.\n');
    process.exit(0);
}

const folders = fs.readdirSync(authPath).filter(f => 
    fs.statSync(path.join(authPath, f)).isDirectory() && f.startsWith('session-')
);

console.log(`📁 Encontradas ${folders.length} pasta(s) de sessão:\n`);
folders.forEach(folder => console.log(`   - ${folder}`));

if (folders.length === 0) {
    console.log('\n✓ Nenhuma sessão para limpar.\n');
    process.exit(0);
}

console.log('\n🧹 Iniciando limpeza...\n');

let success = 0;
let failed = 0;

folders.forEach(folder => {
    const folderPath = path.join(authPath, folder);
    try {
        fs.rmSync(folderPath, { recursive: true, force: true });
        console.log(`   ✓ Deletado: ${folder}`);
        success++;
    } catch (e) {
        console.error(`   ✗ Erro ao deletar ${folder}: ${e.message}`);
        failed++;
    }
});

console.log(`\n📊 Resultado:`);
console.log(`   ✓ Sucesso: ${success}`);
console.log(`   ✗ Falhas: ${failed}`);
console.log(`\n✅ Limpeza concluída!\n`);
