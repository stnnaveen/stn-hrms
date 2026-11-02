-- New dispute type: beyond the radius only by the GPS accuracy allowance (amber, for HR; never a red flag or review).
alter type flag_kind add value if not exists 'radius_edge';
