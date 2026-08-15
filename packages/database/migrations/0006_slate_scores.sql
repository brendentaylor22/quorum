-- Keep the recommender's own score alongside the reason it produced.
--
-- The reason is prose, so it cannot answer "is the recommender actually
-- doing anything?" — two rounds of plausible sentences look the same whether
-- scoring works or is stuck. The score is the number that drove the pick, so
-- storing it makes a slate auditable after the fact and lets the client show
-- what the group's predicted willingness was.
--
-- Null on a top-rated slate, and on exploration slots, which are chosen at
-- random rather than by score.

ALTER TABLE room_items ADD COLUMN score REAL;
