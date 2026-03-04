use serde::{Deserialize, Serialize};
use std::fmt;

/// Euchre uses 24 cards: 9, 10, J, Q, K, A in each of 4 suits.
/// Card index layout (0-23):
///   Hearts:   9h=0,  10h=1,  Jh=2,  Qh=3,  Kh=4,  Ah=5
///   Diamonds: 9d=6,  10d=7,  Jd=8,  Qd=9,  Kd=10, Ad=11
///   Clubs:    9c=12, 10c=13, Jc=14, Qc=15, Kc=16, Ac=17
///   Spades:   9s=18, 10s=19, Js=20, Qs=21, Ks=22, As=23

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum Suit {
    Hearts = 0,
    Diamonds = 1,
    Clubs = 2,
    Spades = 3,
}

impl Suit {
    pub const ALL: [Suit; 4] = [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades];

    /// Returns the same-color suit (used for Left Bower logic).
    /// Hearts <-> Diamonds, Clubs <-> Spades
    pub fn same_color(self) -> Suit {
        match self {
            Suit::Hearts => Suit::Diamonds,
            Suit::Diamonds => Suit::Hearts,
            Suit::Clubs => Suit::Spades,
            Suit::Spades => Suit::Clubs,
        }
    }
}

impl fmt::Display for Suit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Suit::Hearts => write!(f, "♥"),
            Suit::Diamonds => write!(f, "♦"),
            Suit::Clubs => write!(f, "♣"),
            Suit::Spades => write!(f, "♠"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum Rank {
    Nine = 0,
    Ten = 1,
    Jack = 2,
    Queen = 3,
    King = 4,
    Ace = 5,
}

impl Rank {
    pub const ALL: [Rank; 6] = [Rank::Nine, Rank::Ten, Rank::Jack, Rank::Queen, Rank::King, Rank::Ace];
}

impl fmt::Display for Rank {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Rank::Nine => write!(f, "9"),
            Rank::Ten => write!(f, "10"),
            Rank::Jack => write!(f, "J"),
            Rank::Queen => write!(f, "Q"),
            Rank::King => write!(f, "K"),
            Rank::Ace => write!(f, "A"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Card {
    pub suit: Suit,
    pub rank: Rank,
}

impl Card {
    pub const fn new(suit: Suit, rank: Rank) -> Self {
        Self { suit, rank }
    }

    /// Card index 0-23: suit * 6 + rank
    pub const fn index(self) -> usize {
        self.suit as usize * 6 + self.rank as usize
    }

    /// Construct from index 0-23
    pub const fn from_index(idx: usize) -> Self {
        let suit = match idx / 6 {
            0 => Suit::Hearts,
            1 => Suit::Diamonds,
            2 => Suit::Clubs,
            _ => Suit::Spades,
        };
        let rank = match idx % 6 {
            0 => Rank::Nine,
            1 => Rank::Ten,
            2 => Rank::Jack,
            3 => Rank::Queen,
            4 => Rank::King,
            _ => Rank::Ace,
        };
        Self { suit, rank }
    }

    /// The effective suit of this card given trump.
    /// The Left Bower (Jack of same-color suit) counts as trump.
    pub fn effective_suit(self, trump: Suit) -> Suit {
        if self.rank == Rank::Jack && self.suit == trump.same_color() {
            trump
        } else {
            self.suit
        }
    }

    /// Returns the trick-taking power of this card within its effective suit.
    /// Higher = stronger. Only meaningful for comparing cards of the same effective suit.
    /// Trump suit hierarchy: Right Bower (5) > Left Bower (4) > A(3) > K(2) > Q(1) > 10(0.5) > 9(0)
    /// Off-suit hierarchy: A(3) > K(2) > Q(1) > J(0.75) > 10(0.5) > 9(0)
    /// We use integers shifted to avoid floats:
    ///   Right Bower=12, Left Bower=11, A=10, K=8, Q=6, J(non-bower)=5, 10=4, 9=2
    pub fn trick_power(self, trump: Suit) -> u8 {
        // Right Bower: Jack of trump suit
        if self.rank == Rank::Jack && self.suit == trump {
            return 12;
        }
        // Left Bower: Jack of same-color suit
        if self.rank == Rank::Jack && self.suit == trump.same_color() {
            return 11;
        }
        match self.rank {
            Rank::Ace => 10,
            Rank::King => 8,
            Rank::Queen => 6,
            Rank::Jack => 5,
            Rank::Ten => 4,
            Rank::Nine => 2,
        }
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.rank, self.suit)
    }
}

/// A set of cards represented as a 24-bit bitmask in a u32.
/// Bit i corresponds to Card::from_index(i).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct CardSet(pub u32);

impl CardSet {
    pub const EMPTY: CardSet = CardSet(0);
    pub const FULL_DECK: CardSet = CardSet((1 << 24) - 1);

    pub fn contains(self, card: Card) -> bool {
        self.0 & (1 << card.index()) != 0
    }

    pub fn insert(&mut self, card: Card) {
        self.0 |= 1 << card.index();
    }

    pub fn remove(&mut self, card: Card) {
        self.0 &= !(1 << card.index());
    }

    pub fn count(self) -> u32 {
        self.0.count_ones()
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn union(self, other: CardSet) -> CardSet {
        CardSet(self.0 | other.0)
    }

    pub fn intersection(self, other: CardSet) -> CardSet {
        CardSet(self.0 & other.0)
    }

    pub fn difference(self, other: CardSet) -> CardSet {
        CardSet(self.0 & !other.0)
    }

    /// Mask for all cards of a given suit (natural suit, ignoring trump).
    pub fn suit_mask(suit: Suit) -> CardSet {
        let base = suit as u32 * 6;
        CardSet(0b111111 << base)
    }

    /// Mask for all cards of a given effective suit (considering Left Bower).
    pub fn effective_suit_mask(suit: Suit, trump: Suit) -> CardSet {
        let mut mask = Self::suit_mask(suit);
        if suit == trump {
            // Add Left Bower (Jack of same-color suit)
            let left_bower = Card::new(trump.same_color(), Rank::Jack);
            mask.insert(left_bower);
        } else if suit == trump.same_color() {
            // Remove Jack (it's the Left Bower, belongs to trump)
            let left_bower = Card::new(suit, Rank::Jack);
            mask.remove(left_bower);
        }
        mask
    }

    /// Iterate over all cards in this set.
    pub fn iter(self) -> CardSetIter {
        CardSetIter(self.0)
    }
}

pub struct CardSetIter(u32);

impl Iterator for CardSetIter {
    type Item = Card;

    fn next(&mut self) -> Option<Card> {
        if self.0 == 0 {
            return None;
        }
        let idx = self.0.trailing_zeros() as usize;
        self.0 &= self.0 - 1; // Clear lowest set bit
        Some(Card::from_index(idx))
    }
}

impl IntoIterator for CardSet {
    type Item = Card;
    type IntoIter = CardSetIter;

    fn into_iter(self) -> CardSetIter {
        self.iter()
    }
}

/// Generate all 24 cards in the Euchre deck.
pub fn euchre_deck() -> [Card; 24] {
    let mut deck = [Card::new(Suit::Hearts, Rank::Nine); 24];
    for (i, card) in deck.iter_mut().enumerate() {
        *card = Card::from_index(i);
    }
    deck
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_indexing_roundtrips() {
        for i in 0..24 {
            let card = Card::from_index(i);
            assert_eq!(card.index(), i);
        }
    }

    #[test]
    fn same_color_pairs() {
        assert_eq!(Suit::Hearts.same_color(), Suit::Diamonds);
        assert_eq!(Suit::Diamonds.same_color(), Suit::Hearts);
        assert_eq!(Suit::Clubs.same_color(), Suit::Spades);
        assert_eq!(Suit::Spades.same_color(), Suit::Clubs);
    }

    #[test]
    fn left_bower_effective_suit() {
        let jd = Card::new(Suit::Diamonds, Rank::Jack);
        // Hearts is trump → Jack of Diamonds is Left Bower → effective suit is Hearts
        assert_eq!(jd.effective_suit(Suit::Hearts), Suit::Hearts);
        // Diamonds is trump → Jack of Diamonds is Right Bower → effective suit is Diamonds
        assert_eq!(jd.effective_suit(Suit::Diamonds), Suit::Diamonds);
        // Clubs is trump → Jack of Diamonds is just a regular Jack → Diamonds
        assert_eq!(jd.effective_suit(Suit::Clubs), Suit::Diamonds);
    }

    #[test]
    fn trick_power_ordering() {
        let trump = Suit::Hearts;
        let right = Card::new(Suit::Hearts, Rank::Jack);
        let left = Card::new(Suit::Diamonds, Rank::Jack);
        let ace_trump = Card::new(Suit::Hearts, Rank::Ace);
        let king_trump = Card::new(Suit::Hearts, Rank::King);
        let nine_trump = Card::new(Suit::Hearts, Rank::Nine);

        assert!(right.trick_power(trump) > left.trick_power(trump));
        assert!(left.trick_power(trump) > ace_trump.trick_power(trump));
        assert!(ace_trump.trick_power(trump) > king_trump.trick_power(trump));
        assert!(king_trump.trick_power(trump) > nine_trump.trick_power(trump));
    }

    #[test]
    fn cardset_basic_ops() {
        let mut set = CardSet::EMPTY;
        let card = Card::new(Suit::Hearts, Rank::Ace);
        assert!(!set.contains(card));
        set.insert(card);
        assert!(set.contains(card));
        assert_eq!(set.count(), 1);
        set.remove(card);
        assert!(!set.contains(card));
        assert_eq!(set.count(), 0);
    }

    #[test]
    fn cardset_full_deck() {
        assert_eq!(CardSet::FULL_DECK.count(), 24);
    }

    #[test]
    fn cardset_iter() {
        let set = CardSet::FULL_DECK;
        let cards: Vec<Card> = set.iter().collect();
        assert_eq!(cards.len(), 24);
    }

    #[test]
    fn effective_suit_mask_includes_left_bower() {
        let trump = Suit::Hearts;
        let trump_mask = CardSet::effective_suit_mask(Suit::Hearts, trump);
        let left_bower = Card::new(Suit::Diamonds, Rank::Jack);
        assert!(trump_mask.contains(left_bower));
        // Jack of Diamonds should NOT be in the Diamonds effective suit mask
        let diamond_mask = CardSet::effective_suit_mask(Suit::Diamonds, trump);
        assert!(!diamond_mask.contains(left_bower));
    }

    #[test]
    fn euchre_deck_has_24_cards() {
        let deck = euchre_deck();
        assert_eq!(deck.len(), 24);
        // All unique
        let mut set = CardSet::EMPTY;
        for card in &deck {
            assert!(!set.contains(*card));
            set.insert(*card);
        }
        assert_eq!(set, CardSet::FULL_DECK);
    }

    #[test]
    fn non_bower_jack_trick_power() {
        // Jack of Clubs when Hearts is trump — not a bower, regular jack power
        let jc = Card::new(Suit::Clubs, Rank::Jack);
        assert_eq!(jc.trick_power(Suit::Hearts), 5); // Regular jack
    }

    #[test]
    fn all_four_bower_combos() {
        // Test all 4 trump suits for bower assignments
        for trump in Suit::ALL {
            let right = Card::new(trump, Rank::Jack);
            let left = Card::new(trump.same_color(), Rank::Jack);
            assert_eq!(right.effective_suit(trump), trump);
            assert_eq!(left.effective_suit(trump), trump);
            assert!(right.trick_power(trump) > left.trick_power(trump));
            assert!(left.trick_power(trump) > Card::new(trump, Rank::Ace).trick_power(trump));
        }
    }

    #[test]
    fn effective_suit_mask_all_trumps() {
        // For each trump suit, verify mask includes right bower, left bower,
        // and all other cards of that suit
        for trump in Suit::ALL {
            let mask = CardSet::effective_suit_mask(trump, trump);
            // Should contain 7 cards: 6 natural + left bower
            assert_eq!(mask.count(), 7);
            // Right bower
            assert!(mask.contains(Card::new(trump, Rank::Jack)));
            // Left bower
            assert!(mask.contains(Card::new(trump.same_color(), Rank::Jack)));
            // All other cards of trump suit
            for rank in Rank::ALL {
                assert!(mask.contains(Card::new(trump, rank)));
            }
        }
    }

    #[test]
    fn effective_suit_mask_same_color_suit_has_5_cards() {
        // The same-color suit loses its Jack (becomes Left Bower)
        let trump = Suit::Hearts;
        let diamond_mask = CardSet::effective_suit_mask(Suit::Diamonds, trump);
        assert_eq!(diamond_mask.count(), 5); // 6 - Jack = 5
        assert!(!diamond_mask.contains(Card::new(Suit::Diamonds, Rank::Jack)));
    }

    #[test]
    fn effective_suit_mask_offsuit_unchanged() {
        // Suits not related to trump are unchanged (6 cards each)
        let trump = Suit::Hearts;
        let club_mask = CardSet::effective_suit_mask(Suit::Clubs, trump);
        assert_eq!(club_mask.count(), 6);
        let spade_mask = CardSet::effective_suit_mask(Suit::Spades, trump);
        assert_eq!(spade_mask.count(), 6);
    }

    #[test]
    fn cardset_set_operations() {
        let mut a = CardSet::EMPTY;
        a.insert(Card::new(Suit::Hearts, Rank::Ace));
        a.insert(Card::new(Suit::Clubs, Rank::Nine));

        let mut b = CardSet::EMPTY;
        b.insert(Card::new(Suit::Hearts, Rank::Ace));
        b.insert(Card::new(Suit::Spades, Rank::King));

        let union = a.union(b);
        assert_eq!(union.count(), 3);

        let intersection = a.intersection(b);
        assert_eq!(intersection.count(), 1);
        assert!(intersection.contains(Card::new(Suit::Hearts, Rank::Ace)));

        let diff = a.difference(b);
        assert_eq!(diff.count(), 1);
        assert!(diff.contains(Card::new(Suit::Clubs, Rank::Nine)));
    }

    #[test]
    fn card_display_formatting() {
        let card = Card::new(Suit::Hearts, Rank::Ace);
        assert_eq!(format!("{}", card), "A♥");
        let card2 = Card::new(Suit::Spades, Rank::Ten);
        assert_eq!(format!("{}", card2), "10♠");
    }
}
