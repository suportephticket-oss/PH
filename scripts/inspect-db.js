const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err.message);
        return;
    }
    console.log('Conectado ao banco de dados SQLite para inspeção de schema.');
});

function inspectSchema() {
    console.log("\n--- Schema da Tabela: tickets ---");
    db.all("PRAGMA table_info(tickets);", [], (err, columns) => {
        if (err) {
            console.error("Erro ao buscar schema da tabela tickets:", err.message);
        } else if (columns.length === 0) {
            console.log("Tabela 'tickets' não encontrada.");
        } else {
            console.log("Colunas da tabela 'tickets':");
            console.table(columns.map(c => ({ cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, pk: c.pk })));
        }

        console.log("\n--- Schema da Tabela: connections ---");
        db.all("PRAGMA table_info(connections);", [], (err, conn_columns) => {
            if (err) {
                console.error("Erro ao buscar schema da tabela connections:", err.message);
            } else if (conn_columns.length === 0) {
                console.log("Tabela 'connections' não encontrada.");
            } else {
                console.log("Colunas da tabela 'connections':");
                console.table(conn_columns.map(c => ({ cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, pk: c.pk })));
            }

            // Fechar a conexão com o banco de dados
            db.close((err) => {
                if (err) {
                    console.error('Erro ao fechar a conexão com o banco de dados:', err.message);
                } else {
                    console.log('Conexão com o banco de dados fechada.');
                }
            });
        });
    });
}

inspectSchema();
