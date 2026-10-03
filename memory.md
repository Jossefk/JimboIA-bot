# MEMORY.MD — Arquitectura del Sistema de Memoria de Jimbo AI 🧠💾

Este documento define la estructura de memoria a corto y largo plazo, el esquema de base de datos SQLite con **FTS5 (Full-Text Search)**, la gestión de recordatorios programados en segundo plano y la estrategia de extracción de recuerdos de Jimbo.

---

## 1. Niveles de Memoria

Jimbo opera con cuatro niveles de memoria complementarios:

```
┌────────────────────────────────────────────────────────┐
│ 1. Memoria de Trabajo (In-Memory Buffer)               │
│    Últimos 10-15 mensajes por canal (turnos recientes) │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ 2. Memoria de Perfil de Usuario (SQLite: `users`)       │
│    Afinidad (-100 a +100), apodos, zona horaria, fichas│
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ 3. Memoria Episódica y Hechos (SQLite + FTS5: `memories`)│
│    Anécdotas, gustos, datos personales, importancia 1-5│
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│ 4. Memoria Programada / Tareas (SQLite: `reminders`)    │
│    Recordatorios futuros ("avísame a las 3pm...")       │
└────────────────────────────────────────────────────────┘
```

---

## 2. Esquema de Base de Datos SQLite

La base de datos utiliza el motor nativo de Node.js `node:sqlite` con modo **WAL (Write-Ahead Logging)** para lecturas concurrentes instantáneas sin bloqueos.

### 2.1 Tablas Relacionales

```sql
-- 1. Usuarios y Perfiles Sociales
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT,
    timezone TEXT DEFAULT 'America/Caracas',
    chips INTEGER DEFAULT 1000,
    affinity INTEGER DEFAULT 0,                 -- -100 (enemigo/picado) a +100 (gran pana)
    personality_notes TEXT DEFAULT '',          -- Rasgos clave (ej: "juega LoL", "trabaja remoto")
    total_games_played INTEGER DEFAULT 0,
    total_games_won INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- 2. Recuerdos, Hechos y Anécdotas
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,                               -- ID del usuario (o NULL si es del servidor general)
    guild_id TEXT,                              -- ID del servidor
    category TEXT DEFAULT 'general',            -- 'gusto', 'anecdota', 'trabajo', 'vida', 'anime', 'juego', 'balatro'
    content TEXT NOT NULL,                      -- El hecho memorable sintetizado
    importance INTEGER DEFAULT 1,               -- Escala de 1 (menor) a 5 (crítico/vital)
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 3. Tabla Virtual FTS5 para Búsquedas por Texto Rápido
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    category,
    content='memories',
    content_rowid='id'
);

-- Triggers para mantener sincronizado el índice FTS5 automáticamente
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES('delete', old.id, old.content, old.category);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, category) VALUES('delete', old.id, old.content, old.category);
    INSERT INTO memories_fts(rowid, content, category) VALUES (new.id, new.content, new.category);
END;

-- 4. Recordatorios y Tareas Programadas ("recuérdame...")
CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    guild_id TEXT,
    reminder_text TEXT NOT NULL,
    trigger_at TEXT NOT NULL,                   -- Formato ISO o timestamp UTC 'YYYY-MM-DD HH:MM:SS'
    send_dm INTEGER DEFAULT 0,                  -- 1 = DM privado, 0 = Canal público
    status TEXT DEFAULT 'pending',              -- 'pending', 'completed', 'cancelled'
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminders_pending 
ON reminders(status, trigger_at) 
WHERE status = 'pending';

-- 5. Configuración del Servidor
CREATE TABLE IF NOT EXISTS server_settings (
    guild_id TEXT PRIMARY KEY,
    chime_in_rate REAL DEFAULT 0.03,
    allowed_channels TEXT DEFAULT '[]',
    personality_override TEXT DEFAULT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
```

---

## 3. Estrategia de Recuperación de Recuerdos

Cuando Jimbo va a generar una respuesta para un usuario o canal, consulta sus recuerdos priorizando dos factores:
1. **Importancia intrínseca** (relevancia emocional o factual del recuerdo, peso 1-5).
2. **Frescura / Reciprocidad temporal** (recuerdos recientes pesan más que anécdotas de hace 6 meses).
3. **Búsqueda FTS5 contextual**: Si la conversación actual habla de un tema clave (ej: "anime", "computadora", "trabajo"), busca en `memories_fts`.

### 3.1 Consulta Ponderada en SQLite

```sql
-- Obtener los mejores 4-5 recuerdos del usuario mezclando relevancia e importancia
SELECT m.id, m.category, m.content, m.importance, m.created_at
FROM memories m
WHERE m.user_id = ?
ORDER BY 
    m.importance DESC,
    m.created_at DESC
LIMIT 5;
```

### 3.2 Búsqueda Contextual con FTS5

```sql
-- Buscar recuerdos relacionados con las palabras clave del chat actual
SELECT m.id, m.category, m.content, m.importance
FROM memories_fts fts
JOIN memories m ON m.id = fts.rowid
WHERE memories_fts MATCH ? AND (m.user_id = ? OR m.guild_id = ?)
ORDER BY rank, m.importance DESC
LIMIT 4;
```

---

## 4. Extracción de Recuerdos en Segundo Plano

Para no retrasar la respuesta del bot en Discord, la extracción de memoria se ejecuta de forma asíncrona tras enviar el mensaje al canal.

### 4.1 Prompt del Extractor (Gemini 2.5 Flash Lite)

```json
{
  "system_instruction": "Eres un extractor de memoria para Jimbo. Analiza el mensaje del usuario y extrae información personal duradera (gustos, anécdotas, trabajo, videojuegos favoritos, situaciones de vida). Ignora saludos, insultos triviales o charla efímera.",
  "response_format": {
    "type": "object",
    "properties": {
      "has_memory": { "type": "boolean" },
      "category": { "type": "string", "enum": ["gusto", "anecdota", "trabajo", "vida", "anime", "juego", "balatro", "general"] },
      "content": { "type": "string", "description": "1 frase corta resumiendo el hecho memorable" },
      "importance": { "type": "integer", "description": "1 a 5, donde 5 es un dato crítico (ej: cumpleaños, nombre de su pareja, trabajo nuevo)" },
      "affinity_delta": { "type": "integer", "description": "-5 a +5 según afinidad demostrada" }
    },
    "required": ["has_memory"]
  }
}
```

---

## 5. Motor de Recordatorios y Tareas (`reminders`)

### 5.1 Flujo del Function Calling (`set_reminder`)
Cuando el usuario dice:  
*— "Jimbo, recuérdame mañana a las 2pm comprar los panes para la hamburguesa"*

1. **Gemini Tool Call**: El modelo deduce la hora actual del servidor y calcula el `trigger_at` en UTC. Invoca la tool:
   ```json
   {
     "name": "set_reminder",
     "args": {
       "reminder_text": "Comprar los panes para la hamburguesa",
       "trigger_iso": "2026-10-03T18:00:00.000Z",
       "send_dm": false
     }
   }
   ```
2. **Inserción en SQLite**: Se guarda con estado `'pending'`.
3. **Confirmación en personaje**: Jimbo confirma en el chat con su estilo:  
   *— "Anotado mi pana, mañana a las 2pm te pego el grito para que no se te queden frías esas hamburguesas 🍔🃏"*.

### 5.2 Background Ticker (Cron Interno)

En `index.js` o un servicio dedicado `reminderService.js`, un `setInterval` liviano se ejecuta cada 30 segundos:

```javascript
function startReminderTicker(client) {
  setInterval(async () => {
    try {
      const nowUtc = new Date().toISOString();
      const dueReminders = db.getDueReminders(nowUtc);

      for (const reminder of dueReminders) {
        try {
          const userTag = `<@${reminder.user_id}>`;
          const text = `⏰ ¡Epa ${userTag}! Te dije que te iba a recordar esto:\n> **${reminder.reminder_text}**\n🃏 ¡Ponte las pilas!`;

          if (reminder.send_dm) {
            const user = await client.users.fetch(reminder.user_id);
            await user.send(text);
          } else {
            const channel = await client.channels.fetch(reminder.channel_id);
            if (channel) await channel.send(text);
          }

          db.markReminderCompleted(reminder.id);
        } catch (err) {
          console.error(`Error enviando recordatorio #${reminder.id}:`, err);
        }
      }
    } catch (e) {
      console.error('Error en el ticker de recordatorios:', e);
    }
  }, 30_000);
}
```

---

## 6. Mantenimiento y Poda de Memoria

Para garantizar que el archivo `jimbo.sqlite` se mantenga ligero y dentro de los límites de almacenamiento de la VM de Oracle:
- **Límite de recuerdos por usuario**: Máximo 40 recuerdos activos. Cuando un usuario supera los 40, se purgan automáticamente los que tengan `importance = 1` más antiguos.
- **Limpieza de recordatorios**: Los recordatorios con estado `'completed'` con más de 30 días de antigüedad se eliminan semanalmente en una rutina de mantenimiento SQLite (`DELETE FROM reminders WHERE status = 'completed' AND created_at < datetime('now', '-30 days')`).
- **Comando `VACUUM` / Optimización WAL**: Ejecutado de forma automática mensualmente para consolidar el archivo `.sqlite`.
