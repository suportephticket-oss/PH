const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao DB:', err.message);
    process.exit(1);
  }
});

db.all('SELECT id, name, email FROM users LIMIT 20', [], (err, rows) => {
  if (err) {
    console.error('Erro na query:', err.message);
    db.close();
    process.exit(1);
  }
  console.log(JSON.stringify(rows, null, 2));
  db.close();
});
