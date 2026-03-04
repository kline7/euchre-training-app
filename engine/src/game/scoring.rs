use crate::game::state::{GameState, team_of};

/// Score result for a completed hand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandScore {
    pub maker_team: u8,
    pub maker_tricks: u8,
    pub defender_tricks: u8,
    pub points: i8, // Positive for maker team, negative if euchred
    pub is_euchre: bool,
    pub is_sweep: bool,
    pub is_alone_sweep: bool,
}

/// Calculate the score for a completed hand.
pub fn score_hand(state: &GameState) -> HandScore {
    let maker_team = team_of(state.maker);
    let maker_tricks = state.tricks_won[maker_team as usize];
    let defender_tricks = state.tricks_won[1 - maker_team as usize];

    let (points, is_euchre, is_sweep, is_alone_sweep) = if maker_tricks >= 3 {
        if maker_tricks == 5 && state.alone {
            (4, false, true, true) // Alone sweep = 4 points
        } else if maker_tricks == 5 {
            (2, false, true, false) // Sweep = 2 points
        } else {
            (1, false, false, false) // Simple win = 1 point
        }
    } else {
        (-2, true, false, false) // Euchred = defenders get 2 points
    };

    HandScore {
        maker_team,
        maker_tricks,
        defender_tricks,
        points,
        is_euchre,
        is_sweep,
        is_alone_sweep,
    }
}

/// Apply a hand score to the game scores. Returns updated scores.
pub fn apply_score(scores: [u8; 2], hand_score: &HandScore) -> [u8; 2] {
    let mut new_scores = scores;
    if hand_score.points > 0 {
        new_scores[hand_score.maker_team as usize] += hand_score.points as u8;
    } else {
        // Euchred — defenders get 2 points
        new_scores[1 - hand_score.maker_team as usize] += (-hand_score.points) as u8;
    }
    new_scores
}

/// Check if a game is over (first team to 10 points).
pub fn is_game_over(scores: [u8; 2]) -> Option<u8> {
    if scores[0] >= 10 {
        Some(0)
    } else if scores[1] >= 10 {
        Some(1)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Card, CardSet, Suit, Rank};
    use crate::game::state::GameState;

    fn hand_with_tricks(maker: u8, maker_tricks: u8, alone: bool) -> GameState {
        let mut state = GameState::new_hand(
            [CardSet::EMPTY; 4],
            Card::new(Suit::Hearts, Rank::Nine),
            0,
            [0, 0],
        );
        state.maker = maker;
        state.alone = alone;
        let maker_team = team_of(maker);
        state.tricks_won[maker_team as usize] = maker_tricks;
        state.tricks_won[1 - maker_team as usize] = 5 - maker_tricks;
        state
    }

    #[test]
    fn simple_win() {
        let state = hand_with_tricks(0, 3, false);
        let score = score_hand(&state);
        assert_eq!(score.points, 1);
        assert!(!score.is_euchre);
        assert!(!score.is_sweep);
    }

    #[test]
    fn sweep() {
        let state = hand_with_tricks(0, 5, false);
        let score = score_hand(&state);
        assert_eq!(score.points, 2);
        assert!(score.is_sweep);
        assert!(!score.is_alone_sweep);
    }

    #[test]
    fn alone_sweep() {
        let state = hand_with_tricks(0, 5, true);
        let score = score_hand(&state);
        assert_eq!(score.points, 4);
        assert!(score.is_alone_sweep);
    }

    #[test]
    fn euchred() {
        let state = hand_with_tricks(0, 2, false);
        let score = score_hand(&state);
        assert_eq!(score.points, -2);
        assert!(score.is_euchre);
    }

    #[test]
    fn apply_score_works() {
        let scores = [7, 8];
        let hand_score = HandScore {
            maker_team: 0,
            maker_tricks: 5,
            defender_tricks: 0,
            points: 2,
            is_euchre: false,
            is_sweep: true,
            is_alone_sweep: false,
        };
        let new_scores = apply_score(scores, &hand_score);
        assert_eq!(new_scores, [9, 8]);
    }

    #[test]
    fn euchre_gives_defenders_points() {
        let scores = [5, 5];
        let hand_score = HandScore {
            maker_team: 0,
            maker_tricks: 2,
            defender_tricks: 3,
            points: -2,
            is_euchre: true,
            is_sweep: false,
            is_alone_sweep: false,
        };
        let new_scores = apply_score(scores, &hand_score);
        assert_eq!(new_scores, [5, 7]); // Defenders (team 1) get 2
    }

    #[test]
    fn game_over_at_10() {
        assert_eq!(is_game_over([10, 5]), Some(0));
        assert_eq!(is_game_over([5, 10]), Some(1));
        assert_eq!(is_game_over([9, 9]), None);
        assert_eq!(is_game_over([12, 5]), Some(0)); // Over 10 is fine
    }
}
