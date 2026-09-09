Task: add the graded TRIGGER and FUNCTION. Reviews already exist, so
build on that.

Before writing anything, show me your plan and wait for me to say go:
- which table the trigger fires on and on which events
- whether restaurants already has stored rating columns or if we need
  a migration to add them
- what happens to the rating when a review is edited or deleted

Then implement:

1. A FUNCTION that takes a restaurant id and returns that restaurant's
   average rating as a computed value.
2. A TRIGGER on the reviews table (INSERT, UPDATE and DELETE) that keeps
   the restaurant's stored rating and review count correct. Handle
   deletes properly — no reviews left should not leave a stale rating.
3. Backfill existing rows so current data is correct.
4. Put them in a new SQL file and tell me exactly where it goes in the
   psql run order in CLAUDE.md.

Rules:
- Do NOT touch place_order in this session.
- Comment every block with WHY it exists, not what it does.

Then, in the same session, create docs/FLOW.md and write the entry for
this feature in the format specified in CLAUDE.md. Explain the trigger
and the function in plain English, defining every technical term in the
same sentence I'd need it, and end with the SQL and one sentence on
each query. Assume I have to explain this out loud tomorrow.