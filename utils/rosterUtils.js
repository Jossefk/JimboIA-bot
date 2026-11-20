const db = require('../database/db.js');

const PRESENCE_LABELS = {
	online: 'en línea',
	idle: 'ausente',
	dnd: 'no molestar',
	offline: 'desconectado',
};

/**
 * Construye el directorio vivo combinando la base de datos SQLite y la caché de miembros/presencias de Discord
 */
function buildGuildRoster(guild, channel = null) {
	const guildId = guild?.id || null;
	const dbUsers = db.getKnownUsers(guildId, 35);
	const rosterMap = new Map();

	for (const u of dbUsers) {
		rosterMap.set(u.user_id, {
			userId: u.user_id,
			username: u.username,
			displayName: u.display_name || u.username,
			realName: u.real_name || '',
			aliases: u.aliases || '',
			personalityNotes: u.personality_notes || '',
			affinity: u.affinity || 0,
			memoryCount: u.memory_count || 0,
			status: null,
			inChannel: true,
			lastSeenAt: u.last_seen_at || u.updated_at || '',
		});
	}

	let hasPresence = Boolean(guild?.client?.hasPrivilegedIntents);

	if (guild && guild.members?.cache) {
		for (const member of guild.members.cache.values()) {
			if (member.user?.bot) continue;

			const rawStatus = member.presence?.status || null;
			if (rawStatus) hasPresence = true;
			const statusLabel = rawStatus ? (PRESENCE_LABELS[rawStatus] || rawStatus) : null;
			const inChannel = channel && typeof channel.permissionsFor === 'function'
				? Boolean(channel.permissionsFor(member)?.has('ViewChannel'))
				: true;

			const existing = rosterMap.get(member.id);
			if (existing) {
				existing.displayName = member.displayName || existing.displayName;
				existing.username = member.user?.username || existing.username;
				if (statusLabel) existing.status = statusLabel;
				existing.inChannel = inChannel;
			}
			else {
				rosterMap.set(member.id, {
					userId: member.id,
					username: member.user?.username || member.displayName,
					displayName: member.displayName || member.user?.username,
					realName: '',
					aliases: '',
					personalityNotes: '',
					affinity: 0,
					memoryCount: 0,
					status: statusLabel,
					inChannel,
					lastSeenAt: '',
				});
			}
		}
	}

	const entries = Array.from(rosterMap.values()).sort((a, b) => {
		const aOnline = a.status && a.status !== 'desconectado' ? 1 : 0;
		const bOnline = b.status && b.status !== 'desconectado' ? 1 : 0;
		if (aOnline !== bOnline) return bOnline - aOnline;
		return (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '');
	});

	return { entries, hasPresence };
}

/**
 * Formatea el directorio del servidor en líneas compactas para el prompt de Gemini
 */
function formatRosterForPrompt(entries = [], hasPresence = false, maxEntries = 25) {
	const visible = entries.filter(e => e.inChannel !== false).slice(0, maxEntries);
	if (visible.length === 0) return '';

	return visible.map(e => {
		const parts = [`- ${e.displayName} (@${e.username})`];
		if (e.realName) parts.push(`Nombre: ${e.realName}`);
		if (e.aliases) parts.push(`Apodos: ${e.aliases}`);
		if (hasPresence && e.status) parts.push(`Estado: ${e.status}`);
		if (e.personalityNotes) parts.push(`Perfil: ${e.personalityNotes}`);
		return parts.join(' | ');
	}).join('\n');
}

module.exports = {
	buildGuildRoster,
	formatRosterForPrompt,
};
