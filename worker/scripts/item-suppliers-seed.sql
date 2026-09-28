-- item_suppliers seed, built from two sources:
--
-- 1. The live "Goods In Records" Google Sheet behind forms.deanops.uk/deliveries
--    (repo: ~/Repos/deliveries, Code.gs -- action getIngredients), read via its
--    own public endpoint on 2026-09-25. Every ingredient row there carries a
--    supplier (or two), so this is the closest thing to ground truth: source
--    'delivered' below.
-- 2. scripts/catalog-overrides.json's item_suppliers block -- a person's own
--    decision, layered on top where the sheet has nothing to say: source
--    'decided' below. Six rows: two items the sheet does not mention at all
--    (Chicken Fillet, Dried Bird Eye Chillies), and four backup-to-Lynas
--    pairings the sheet's single-supplier rows do not show.
--
-- Left out, deliberately:
--
-- - Coconut Milk, Ramen Noodles, Pak Choi, Wakame Seaweed, Menma/Memma
--   Bamboo Shoots: named in one source or the other but match no current
--   catalog item by name -- a catalog gap, not a supplier gap. Out of scope
--   here; needs the catalog itself extended or the name reconciled first.
-- - Eight Kite Packaging lines from the sheet: trace's catalog has no
--   packaging-kind items yet at all, so there is nothing to attach them to.
--
-- The other ten ingredients with no supplier here -- Carrots, Chicken Powder,
-- Chinese Leaves, Dark Soy Sauce, Hoi Sin Sauce Cans, Medium Eggs, Spinach,
-- Sriracha Chilli Sauce, Tomato Ketchup, Tomato Puree Paste -- are confirmed
-- Edinburgh-only (Dean, 2026-09-25) and retired instead, in
-- scripts/retire-edinburgh-only.sql. Not a mapping gap: they should never
-- have shown in a Glasgow goods-in picker at all.
--
-- Run with: npx wrangler d1 execute trace --remote --file scripts/item-suppliers-seed.sql

-- Two suppliers the current suppliers table does not have yet.
INSERT INTO suppliers (id, name) VALUES
('trace:alfa-wholesale', 'Alfa Wholesale'),
('trace:jfc', 'JFC')
ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_at = datetime('now');

INSERT INTO item_suppliers (item_id, supplier_id, source, role) VALUES
('mpucf3ruuoa9', 'trace:lynas', 'delivered', 'primary'),  -- Apple Juice / Lynas
('mpucrpe8rlh5', 'trace:lynas', 'delivered', 'primary'),  -- Cider Vinegar / Lynas
('mpucspup5soi', 'trace:lynas', 'delivered', 'primary'),  -- Cracked Black Pepper / Lynas
('mpuct8qvh4np', 'trace:lynas', 'delivered', 'primary'),  -- Fine Salt / Lynas
('mpucubc5jfmh', 'trace:lynas', 'delivered', 'primary'),  -- Granulated Sugar / Lynas
('mpucv3qqzv8r', 'trace:lynas', 'delivered', 'primary'),  -- Ground White Pepper / Lynas
('mpudkxf1b97v', 'trace:lynas', 'delivered', 'primary'),  -- Paprika Sweet / Lynas
('mpudm0lkbvi8', 'trace:lynas', 'delivered', 'primary'),  -- Syrup / Lynas
('mpv3vzatkfqx', 'trace:lynas', 'delivered', 'primary'),  -- Diced Onions / Lynas
('mpv41h7l50xw', 'trace:lynas', 'delivered', 'primary'),  -- Ginger Root / Lynas
('mpv3t4jmh10w', 'trace:lynas', 'delivered', 'primary'),  -- Peeled Garlic / Lynas
('mpv40knt0qpi', 'trace:lynas', 'delivered', 'primary'),  -- Peeled Potatoes / Lynas
('mpv42tb8kk7i', 'trace:lynas', 'delivered', 'primary'),  -- Red Chillies / Lynas
('mpv452gsu2ll', 'trace:lynas', 'delivered', 'primary'),  -- Spring Onion / Lynas
('mpuhgjfoxsvf', 'trace:tazaki', 'delivered', 'primary'),  -- Aji-no Moto MSG / Tazaki
('mpuzjice0yy4', 'trace:tazaki', 'delivered', 'primary'),  -- Yutaka Gochujang / Tazaki
('mpv2xn3jyhta', 'trace:tazaki', 'delivered', 'primary'),  -- Korean Hot Pepper Powder / Tazaki
('mpv34d94nwrv', 'trace:tazaki', 'delivered', 'primary'),  -- Maggi Seasoning / Tazaki
('mpuh5g71a757', 'trace:tazaki', 'delivered', 'primary'),  -- Mirin Style Seasoning / Tazaki
('mpuh883tfymc', 'trace:tazaki', 'delivered', 'primary'),  -- Rice Vinegar / Tazaki
('mpuhckliqwi7', 'trace:tazaki', 'delivered', 'primary'),  -- Shimaya Konbudashi / Tazaki
('mpv2qb0p8fnl', 'trace:tazaki', 'delivered', 'primary'),  -- Shio G / Tazaki
('mpv2hhfz4f61', 'trace:tazaki', 'delivered', 'primary'),  -- Rajah Whole Red Chillies / Tazaki
('mpv081l4itu1', 'trace:tazaki', 'delivered', 'primary'),  -- Sichuan Toban Chilli Sauce / Tazaki
('mpv2v85ihjwb', 'trace:tazaki', 'delivered', 'primary'),  -- JA Yuzu Seasoning / Tazaki
('trace:pork-belly', 'trace:lynas', 'delivered', 'primary'),  -- Pork Belly / Lynas
('mpucqr4q51x5', 'trace:lynas', 'delivered', 'primary'),  -- Balsamic Vinegar / Lynas
('mpudo60gpapk', 'trace:tazaki', 'delivered', 'primary'),  -- Japanese Soy Sauce / Tazaki
('mpuhe0qrp0fd', 'trace:tazaki', 'delivered', 'primary'),  -- White Miso / Tazaki
('mpuhhy0yrbs7', 'trace:tazaki', 'delivered', 'primary'),  -- Yakisoba Sauce / Tazaki
('mpuzg1idxdpk', 'trace:tazaki', 'delivered', 'primary'),  -- Blended Sesame Oil / Tazaki
('mpuzklcwj9wl', 'trace:tazaki', 'delivered', 'primary'),  -- Haepyo Gochujang / Tazaki
('mpuzmv42k3qt', 'trace:lynas', 'delivered', 'backup'),  -- Ground Bean Sauce / Lynas (backup)
('mpuzmv42k3qt', 'trace:tazaki', 'delivered', 'primary'),  -- Ground Bean Sauce / Tazaki
('mpuzoq8ebfnm', 'trace:tazaki', 'delivered', 'primary'),  -- Hoi Sin Sauce 20kg / Tazaki
('mpuztdxmggmq', 'trace:tazaki', 'delivered', 'primary'),  -- Mae Ploy Red Curry Paste / Tazaki
('mpv2lln2mcfh', 'trace:lynas', 'delivered', 'backup'),  -- Red Bean Curd / Lynas (backup)
('mpv2lln2mcfh', 'trace:tazaki', 'delivered', 'primary'),  -- Red Bean Curd / Tazaki
('mpv0637u6fag', 'trace:lynas', 'delivered', 'backup'),  -- Toban Djan Chilli Bean Sauce / Lynas (backup)
('mpv0637u6fag', 'trace:tazaki', 'delivered', 'primary'),  -- Toban Djan Chilli Bean Sauce / Tazaki
('mpxzs2w0ltja', 'trace:tazaki', 'delivered', 'primary'),  -- Curry Laksa Paste / Tazaki
('mpv2thqzwsy1', 'trace:tazaki', 'delivered', 'primary'),  -- Shio Paitan / Tazaki
('mpv3bqob8hyp', 'trace:alfa-wholesale', 'delivered', 'primary'),  -- Tahini / Alfa Wholesale
('mpv2zxrmbswt', 'trace:tazaki', 'delivered', 'primary'),  -- Spicy Bean Sauce (Mapo) / Tazaki
('mpuzytgt4umm', 'trace:tazaki', 'delivered', 'primary'),  -- Mae Ploy Tom Yum Paste / Tazaki
('mpuzxj9jnk33', 'trace:tazaki', 'delivered', 'primary'),  -- Mae Ploy Green Curry Paste / Tazaki
('ms4h8bkmsw2l', 'trace:lynas', 'delivered', 'primary'),  -- White Truffle Oil / Lynas
('mpuc771xt0jo', 'trace:lynas', 'delivered', 'primary'),  -- 100% Rapeseed Oil / Lynas
('mpv4uvjvdk38', 'trace:lynas', 'delivered', 'primary'),  -- Chicken Carcass / Lynas
('mpv4x5mait4u', 'trace:alfa-wholesale', 'delivered', 'primary'),  -- Chicken Feet / Alfa Wholesale
('mpv4x5mait4u', 'trace:lynas', 'delivered', 'primary'),  -- Chicken Feet / Lynas
('mpv4w2k806ce', 'trace:lynas', 'delivered', 'primary'),  -- Chicken Wings / Lynas
('mpv4ya5ookoo', 'trace:lynas', 'delivered', 'primary'),  -- Femur Bones / Lynas
('mpv4zal7ks2g', 'trace:lynas', 'delivered', 'primary'),  -- Hind Feet / Lynas
('mpv5107jwcxi', 'trace:lynas', 'delivered', 'primary'),  -- Pork Fat / Lynas
('mpv2moh60h4k', 'trace:jfc', 'delivered', 'primary'),  -- Ariake Tonkotsu Paste / JFC
('mpv2moh60h4k', 'trace:tazaki', 'delivered', 'primary'),  -- Ariake Tonkotsu Paste / Tazaki
('trace:chicken-fillet', 'trace:lynas', 'decided', 'primary'),  -- Chicken Fillet / Lynas
('mpv2kmqueish', 'trace:tazaki', 'decided', 'primary'),  -- Dried Bird Eye Chillies / Tazaki
('mpudo60gpapk', 'trace:lynas', 'decided', 'backup'),  -- Japanese Soy Sauce / Lynas (backup)
('mpuh5g71a757', 'trace:lynas', 'decided', 'backup'),  -- Mirin Style Seasoning / Lynas (backup)
('mpuh883tfymc', 'trace:lynas', 'decided', 'backup'),  -- Rice Vinegar / Lynas (backup)
('mpuhckliqwi7', 'trace:lynas', 'decided', 'backup')  -- Shimaya Konbudashi / Lynas (backup)
ON CONFLICT (item_id, supplier_id) DO UPDATE SET
  role = excluded.role,
  updated_at = datetime('now');
