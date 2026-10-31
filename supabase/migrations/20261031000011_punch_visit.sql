-- OD venue check-in: a third punch kind that proves the person reached the approved OD venue.
-- It never changes the day's check-in or check-out. Kept in its own file: a new enum value can't be used in the same transaction.
alter type punch_kind add value if not exists 'visit';
