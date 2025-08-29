const { Events } = require('discord.js');

module.exports = {
    name: Events.ClientReady,
    once: true, // Este evento solo se ejecuta una vez
    execute(client) {
        console.log(`¡Listo! a balatrear como ${client.user.tag}`);
    },
};