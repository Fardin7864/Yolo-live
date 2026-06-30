-- Register the three profile frames already bundled inside the mobile app.
-- Safe to rerun: existing rows are updated, not duplicated.

INSERT INTO public.profile_frames (
  id,
  name,
  frame_url,
  diamond_cost,
  is_active,
  display_order,
  updated_at
)
VALUES
  ('heart-fantasy', 'Heart Fantasy', 'bundled://heart-fantasy', 0, TRUE, 1, NOW()),
  ('angel-wing',    'Angel Wings',   'bundled://angel-wing',    0, TRUE, 2, NOW()),
  ('royal-gold',    'Royal Gold',    'bundled://royal-gold',    0, TRUE, 3, NOW())
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  frame_url = EXCLUDED.frame_url,
  diamond_cost = EXCLUDED.diamond_cost,
  is_active = EXCLUDED.is_active,
  display_order = EXCLUDED.display_order,
  updated_at = NOW();

SELECT id, name, diamond_cost, is_active, display_order
FROM public.profile_frames
WHERE id IN ('heart-fantasy', 'angel-wing', 'royal-gold')
ORDER BY display_order;
