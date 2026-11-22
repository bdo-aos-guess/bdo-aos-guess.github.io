-- One-off conversion: the Daily is now 12 matches (it used to be 15).
-- Results that were saved with more than 12 answers are counted by their FIRST 12 answers only.
-- The points were earned over all the matches and are not saved per match, so they are scaled down in proportion
-- to the correct answers that are kept (example: 12 correct / 2485 pts, the first 12 answers hold 10 correct -> 2485 x 10/12).
-- Safe to run more than once: rows that already have 12 or fewer answers are not touched again.
UPDATE daily_scores SET
  points  = CASE
              WHEN (length(answers) - length(replace(answers, 'c', ''))) = 0 THEN 0
              ELSE CAST(ROUND(points * 1.0
                     * (length(substr(answers, 1, 12)) - length(replace(substr(answers, 1, 12), 'c', '')))
                     / (length(answers) - length(replace(answers, 'c', '')))) AS INTEGER)
            END,
  correct = length(substr(answers, 1, 12)) - length(replace(substr(answers, 1, 12), 'c', '')),
  answers = substr(answers, 1, 12),
  rounds  = length(substr(answers, 1, 12))
WHERE length(answers) > 12;
