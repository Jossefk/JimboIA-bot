// utils/blackjackUtils.js

const suits = ['♠️', '♥️', '♦️', '♣️'];
const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// Crea un mazo de 52 cartas
function createDeck() {
	const deck = [];
	for (const suit of suits) {
		for (const value of values) {
			deck.push({ suit, value });
		}
	}
	return deck;
}

// Baraja el mazo
function shuffleDeck(deck) {
	for (let i = deck.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

// Calcula el valor de una mano (maneja el As como 1 u 11)
function getHandValue(hand) {
	let value = 0;
	let aceCount = 0;
	for (const card of hand) {
		if (card.value === 'A') {
			aceCount++;
			value += 11;
		}
		else if (['K', 'Q', 'J'].includes(card.value)) {
			value += 10;
		}
		else {
			value += parseInt(card.value);
		}
	}
	// Si el valor es > 21 y hay un As, se cuenta como 1 en lugar de 11
	while (value > 21 && aceCount > 0) {
		value -= 10;
		aceCount--;
	}
	return value;
}

// Convierte una mano a un string legible
function getHandString(hand, hideFirstCard = false) {
	if (hideFirstCard) {
		return `[${hand[0].value}${hand[0].suit}] [❓]`;
	}
	return hand.map(card => `[${card.value}${card.suit}]`).join(' ');
}


module.exports = {
	createDeck,
	shuffleDeck,
	getHandValue,
	getHandString,
};