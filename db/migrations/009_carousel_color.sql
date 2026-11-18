-- The company's color for carousels built from slides (#RRGGBB), chosen in Settings. NULL: a neutral slate.
-- The rest of the palette is derived from it and kept readable (see src/lib/colors.ts).
ALTER TABLE workspaces ADD COLUMN carousel_color text;
