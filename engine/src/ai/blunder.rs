use crate::game::card::Card;
use crate::ai::pimc::{PimcResult, EvalResult};

/// Classification of a play decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveGrade {
    Best,        // 0% WPC (optimal play)
    Good,        // 0-2% WPC
    Inaccuracy,  // 2-8% WPC
    Mistake,     // 8-20% WPC
    Blunder,     // 20%+ WPC
}

impl MoveGrade {
    pub fn from_wpc(wpc: f64) -> Self {
        if wpc <= 0.0 {
            MoveGrade::Best
        } else if wpc <= 0.02 {
            MoveGrade::Good
        } else if wpc <= 0.08 {
            MoveGrade::Inaccuracy
        } else if wpc <= 0.20 {
            MoveGrade::Mistake
        } else {
            MoveGrade::Blunder
        }
    }
}

/// Analysis result for a single decision point.
#[derive(Debug, Clone)]
pub struct DecisionAnalysis {
    /// The card that was actually played.
    pub played: Card,
    /// The optimal card (highest expected points).
    pub optimal: Card,
    /// Win probability of the optimal play.
    pub optimal_win_prob: f64,
    /// Win probability of the actual play.
    pub actual_win_prob: f64,
    /// Win Probability Change (optimal - actual). 0 if played optimally.
    pub wpc: f64,
    /// Expected tricks with optimal play.
    pub optimal_tricks: f64,
    /// Expected tricks with actual play.
    pub actual_tricks: f64,
    /// Expected Trick Differential (optimal - actual).
    pub etd: f64,
    /// Classification of this decision.
    pub grade: MoveGrade,
    /// All evaluations for context (what alternatives existed).
    pub all_evals: Vec<EvalResult>,
}

/// Analyze a decision: given PIMC results and the card actually played,
/// compute WPC, ETD, and classify the move.
pub fn analyze_decision(pimc: &PimcResult, played: Card) -> DecisionAnalysis {
    // Find optimal play (highest expected points, tiebreak by win probability)
    let optimal = pimc.evaluations.iter()
        .max_by(|a, b| {
            a.expected_points.partial_cmp(&b.expected_points)
                .unwrap()
                .then(a.win_probability.partial_cmp(&b.win_probability).unwrap())
        })
        .expect("PIMC result must have evaluations");

    let actual = pimc.evaluations.iter()
        .find(|e| e.card == played)
        .expect("played card must be in evaluations");

    let wpc = (optimal.win_probability - actual.win_probability).max(0.0);
    let etd = optimal.expected_tricks - actual.expected_tricks;
    let grade = MoveGrade::from_wpc(wpc);

    DecisionAnalysis {
        played,
        optimal: optimal.card,
        optimal_win_prob: optimal.win_probability,
        actual_win_prob: actual.win_probability,
        wpc,
        optimal_tricks: optimal.expected_tricks,
        actual_tricks: actual.expected_tricks,
        etd,
        grade,
        all_evals: pimc.evaluations.clone(),
    }
}

/// Summary of all decisions in a hand.
#[derive(Debug, Clone)]
pub struct HandAnalysis {
    pub decisions: Vec<DecisionAnalysis>,
    pub total_wpc: f64,
    pub total_etd: f64,
    pub worst_decisions: Vec<usize>, // indices sorted by WPC descending
}

/// Analyze all decisions in a hand.
pub fn analyze_hand(decisions: Vec<DecisionAnalysis>) -> HandAnalysis {
    let total_wpc: f64 = decisions.iter().map(|d| d.wpc).sum();
    let total_etd: f64 = decisions.iter().map(|d| d.etd).sum();

    let mut worst: Vec<(usize, f64)> = decisions.iter()
        .enumerate()
        .map(|(i, d)| (i, d.wpc))
        .collect();
    worst.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let worst_decisions: Vec<usize> = worst.into_iter()
        .filter(|(_, wpc)| *wpc > 0.0)
        .map(|(i, _)| i)
        .collect();

    HandAnalysis {
        decisions,
        total_wpc,
        total_etd,
        worst_decisions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Suit, Rank};
    use crate::ai::pimc::{EvalResult, PimcResult};

    fn make_result(suit: Suit, rank: Rank, win_prob: f64, tricks: f64, points: f64) -> EvalResult {
        EvalResult {
            card: Card::new(suit, rank),
            expected_tricks: tricks,
            win_probability: win_prob,
            expected_points: points,
            determinizations: 100,
        }
    }

    #[test]
    fn optimal_play_grades_best() {
        let pimc = PimcResult {
            evaluations: vec![
                make_result(Suit::Hearts, Rank::Ace, 0.90, 3.5, 1.2),
                make_result(Suit::Clubs, Rank::Nine, 0.40, 2.0, -0.5),
            ],
            total_determinizations: 100,
            total_nodes: 5000,
        };

        let analysis = analyze_decision(&pimc, Card::new(Suit::Hearts, Rank::Ace));
        assert_eq!(analysis.grade, MoveGrade::Best);
        assert!((analysis.wpc - 0.0).abs() < 1e-10);
    }

    #[test]
    fn bad_play_grades_blunder() {
        let pimc = PimcResult {
            evaluations: vec![
                make_result(Suit::Hearts, Rank::Ace, 0.95, 4.0, 1.5),
                make_result(Suit::Clubs, Rank::Nine, 0.30, 1.5, -1.0),
            ],
            total_determinizations: 100,
            total_nodes: 5000,
        };

        let analysis = analyze_decision(&pimc, Card::new(Suit::Clubs, Rank::Nine));
        assert_eq!(analysis.grade, MoveGrade::Blunder);
        assert!((analysis.wpc - 0.65).abs() < 1e-10);
        assert!((analysis.etd - 2.5).abs() < 1e-10);
    }

    #[test]
    fn inaccuracy_threshold() {
        let pimc = PimcResult {
            evaluations: vec![
                make_result(Suit::Hearts, Rank::Ace, 0.80, 3.0, 1.0),
                make_result(Suit::Hearts, Rank::King, 0.75, 2.8, 0.8),
            ],
            total_determinizations: 100,
            total_nodes: 5000,
        };

        let analysis = analyze_decision(&pimc, Card::new(Suit::Hearts, Rank::King));
        assert_eq!(analysis.grade, MoveGrade::Inaccuracy); // 5% WPC
    }

    #[test]
    fn hand_analysis_totals() {
        let d1 = DecisionAnalysis {
            played: Card::new(Suit::Hearts, Rank::Ace),
            optimal: Card::new(Suit::Hearts, Rank::Ace),
            optimal_win_prob: 0.90,
            actual_win_prob: 0.90,
            wpc: 0.0,
            optimal_tricks: 3.5,
            actual_tricks: 3.5,
            etd: 0.0,
            grade: MoveGrade::Best,
            all_evals: vec![],
        };
        let d2 = DecisionAnalysis {
            played: Card::new(Suit::Clubs, Rank::Nine),
            optimal: Card::new(Suit::Hearts, Rank::King),
            optimal_win_prob: 0.80,
            actual_win_prob: 0.55,
            wpc: 0.25,
            optimal_tricks: 3.0,
            actual_tricks: 2.0,
            etd: 1.0,
            grade: MoveGrade::Blunder,
            all_evals: vec![],
        };

        let hand = analyze_hand(vec![d1, d2]);
        assert!((hand.total_wpc - 0.25).abs() < 1e-10);
        assert!((hand.total_etd - 1.0).abs() < 1e-10);
        assert_eq!(hand.worst_decisions, vec![1]); // only d2 has WPC > 0
    }

    #[test]
    fn grade_thresholds() {
        assert_eq!(MoveGrade::from_wpc(0.0), MoveGrade::Best);
        assert_eq!(MoveGrade::from_wpc(0.01), MoveGrade::Good);
        assert_eq!(MoveGrade::from_wpc(0.02), MoveGrade::Good);
        assert_eq!(MoveGrade::from_wpc(0.05), MoveGrade::Inaccuracy);
        assert_eq!(MoveGrade::from_wpc(0.08), MoveGrade::Inaccuracy);
        assert_eq!(MoveGrade::from_wpc(0.15), MoveGrade::Mistake);
        assert_eq!(MoveGrade::from_wpc(0.20), MoveGrade::Mistake);
        assert_eq!(MoveGrade::from_wpc(0.21), MoveGrade::Blunder);
        assert_eq!(MoveGrade::from_wpc(0.50), MoveGrade::Blunder);
    }
}
