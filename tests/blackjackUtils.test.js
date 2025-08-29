const assert = require('assert');
const {
    createDeck,
    shuffleDeck,
    getHandValue,
    getHandString,
} = require('../utils/blackjackUtils.js');

describe('blackjackUtils', () => {
    describe('createDeck', () => {
        it('should create a deck of 52 cards', () => {
            const deck = createDeck();
            assert.strictEqual(deck.length, 52);
        });
    });

    describe('shuffleDeck', () => {
        it('should shuffle the deck', () => {
            const deck1 = createDeck();
            const deck2 = shuffleDeck([...deck1]);
            assert.notDeepStrictEqual(deck1, deck2);
        });
    });

    describe('getHandValue', () => {
        it('should calculate the correct hand value', () => {
            const hand1 = [{ value: 'A' }, { value: 'K' }];
            assert.strictEqual(getHandValue(hand1), 21);

            const hand2 = [{ value: '2' }, { value: '3' }];
            assert.strictEqual(getHandValue(hand2), 5);

            const hand3 = [{ value: 'A' }, { value: 'A' }, { value: 'A' }];
            assert.strictEqual(getHandValue(hand3), 13);
        });
    });

    describe('getHandString', () => {
        it('should return the correct hand string', () => {
            const hand = [{ value: 'A', suit: '♠️' }, { value: 'K', suit: '♥️' }];
            assert.strictEqual(getHandString(hand), '[A♠️] [K♥️]');
        });

        it('should hide the first card if specified', () => {
            const hand = [{ value: 'A', suit: '♠️' }, { value: 'K', suit: '♥️' }];
            assert.strictEqual(getHandString(hand, true), '[A♠️] [❓]');
        });
    });
});
