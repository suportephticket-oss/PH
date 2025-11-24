const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        return console.error('Erro ao conectar ao banco de dados:', err.message);
    }
    console.log('Conectado ao banco de dados SQLite para exclusão forçada.');
});

const connectionId = process.argv[2];

if (!connectionId) {
    console.error("ERRO: Por favor, forneça o ID da conexão que deseja excluir.");
    console.log("Uso: npm run hard-delete -- <ID_DA_CONEXAO>");
    db.close();
    process.exit(1);
}

function hardDeleteConnection(id) {
    db.serialize(() => {
        // 1. Desabilitar verificação de chave estrangeira
        db.run("PRAGMA foreign_keys = OFF;", (err) => {
            if (err) return console.error("Erro ao desabilitar foreign keys:", err.message);
            console.log(`Iniciando exclusão forçada para a conexão ID: ${id}`);

            // 2. Encontrar todos os tickets associados à conexão
            const findTicketsSql = "SELECT id FROM tickets WHERE connection_id = ?";
            db.all(findTicketsSql, [id], (err, tickets) => {
                if (err) return console.error("Erro ao buscar tickets:", err.message);
                
                if (tickets && tickets.length > 0) {
                    const ticketIds = tickets.map(t => t.id);
                    console.log(`Encontrados ${ticketIds.length} tickets para excluir: ${ticketIds.join(', ')}`);

                    // 3. Excluir todas as mensagens associadas a esses tickets
                    const deleteMessagesSql = `DELETE FROM messages WHERE ticket_id IN (${ticketIds.map(() => '?').join(',')})`;
                    db.run(deleteMessagesSql, ticketIds, function(err) {
                        if (err) return console.error("Erro ao excluir mensagens:", err.message);
                        console.log(`  -> ${this.changes} mensagens foram excluídas.`);

                        // 4. Excluir os tickets
                        const deleteTicketsSql = `DELETE FROM tickets WHERE id IN (${ticketIds.map(() => '?').join(',')})`;
                        db.run(deleteTicketsSql, ticketIds, function(err) {
                            if (err) return console.error("Erro ao excluir tickets:", err.message);
                            console.log(`  -> ${this.changes} tickets foram excluídos.`);
                            deleteConnectionRecord(id);
                        });
                    });
                } else {
                    console.log("Nenhum ticket associado encontrado. Prosseguindo para excluir a conexão.");
                    deleteConnectionRecord(id);
                }
            });
        });
    });
}

function deleteConnectionRecord(id) {
    // 5. Excluir a conexão
    db.run("DELETE FROM connections WHERE id = ?", [id], function(err) {
        if (err) return console.error("Erro ao excluir a conexão:", err.message);
        console.log(`  -> ${this.changes} conexão foi excluída.`);

        // 6. Reabilitar a verificação de chave estrangeira e fechar
        db.run("PRAGMA foreign_keys = ON;", (err) => {
            if (err) console.error("Erro ao reabilitar foreign keys:", err.message);
            
            console.log("Operação de exclusão forçada concluída.");
            db.close((err) => {
                if (err) return console.error('Erro ao fechar a conexão.', err.message);
                console.log('Conexão com o banco de dados fechada.');
            });
        });
    });
}

hardDeleteConnection(connectionId);
