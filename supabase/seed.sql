-- Seed data for initial setup

-- First user (Super Admin) - created via Supabase Auth signup.
-- Use the Supabase dashboard to create the first account:
-- Email: admin@clinic.com
-- Password: (choose a secure password)
-- Then promote it to the only privileged role:
-- UPDATE public.users SET is_super_admin = TRUE, is_admin = TRUE
--     WHERE email = 'admin@clinic.com';

-- Sample followers enum
CREATE TYPE follower_type AS ENUM (
    'hassan_hamam',
    'abdel_rahman_ahmed',
    'ahmed_saad',
    'mohamed_ali',
    'mohamed_ahmed',
    'hazem',
    'mohamed_rabie'
);

-- Sample patient for testing (remove in production)
-- INSERT INTO public.patients (name, national_id, mobile, section, source_of_money, is_completed)
-- VALUES ('Test Patient', '12345678901234', '01234567890', 'agamy', 'charity', FALSE);