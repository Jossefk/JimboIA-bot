const LIMBO_ITEMS = [
	{
		key: 'pocion_chamba',
		name: 'Poción de +5% Ganas de Chambear (vencida 2019)',
		price: 60,
		effect: 'Te da 4 minutos de productividad falsa y luego un bajón existencial.',
	},
	{
		key: 'empanada_limbo',
		name: 'Empanada de Cazón del Limbo',
		price: 40,
		effect: 'Frita en aceite de 2014. +15 HP, -10 dignidad, +100% sabor.',
	},
	{
		key: 'elixir_quincena',
		name: 'Elixir de Quincena Eterna (adulterado)',
		price: 120,
		effect: 'Te hace jurar que te alcanza la plata hasta el viernes.',
	},
	{
		key: 'amuleto_corpoelec',
		name: 'Amuleto Anti-Corpoelec',
		price: 150,
		effect: '50% de probabilidad de que no se vaya la luz en plena ranked.',
	},
	{
		key: 'malta_tibia',
		name: 'Malta Tibia de Callejón',
		price: 30,
		effect: 'Restaura 2 puntos de cordura y te recuerda tiempos peores.',
	},
	{
		key: 'polvo_copium',
		name: 'Polvo de Copium Puro (calidad Limbo)',
		price: 90,
		effect: 'Te convence de que la próxima partida sí la ganas y el equipo no es manco.',
	},
	{
		key: 'sello_insomnio',
		name: 'Sello del Insomnio Crónico',
		price: 110,
		effect: 'Te mantiene mirando el techo a las 3 a.m. recordando vergüenzas del 2017.',
	},
	{
		key: 'agua_bendita_chimba',
		name: 'Agua Bendita Rebajada con Cloro',
		price: 75,
		effect: 'Espanta la pava, los bugs en producción y malos pensamientos.',
	},
];

function normalizeCatalogQuery(str = '') {
	return String(str)
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.trim();
}

function findLimboItem(query) {
	if (!query || typeof query !== 'string') return null;
	const exact = LIMBO_ITEMS.find(item => item.key === query.trim());
	if (exact) return exact;

	const norm = normalizeCatalogQuery(query);
	if (!norm) return null;

	return LIMBO_ITEMS.find(item => {
		const keyNorm = normalizeCatalogQuery(item.key);
		const nameNorm = normalizeCatalogQuery(item.name);
		return keyNorm === norm || nameNorm === norm || nameNorm.includes(norm) || keyNorm.includes(norm);
	}) || null;
}

module.exports = {
	LIMBO_ITEMS,
	findLimboItem,
};
