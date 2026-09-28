-- =====================================================================
-- Demo students: 4 profiles with real Supabase Auth logins and enough
-- quiz history to populate the dashboard, knowledge gaps, mistakes and
-- agent recommendations end-to-end. Same names/ages/topics as the
-- offline demo in frontend/index.html, so a live deployment tells the
-- same story as the no-setup demo.
-- Run AFTER 05_protect_answer_key.sql.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Temporarily drop the FK so profiles can be inserted before their
--    matching auth.users rows exist (created in step 3 below).
-- ---------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_id_fkey;

insert into profiles (id, full_name, age_group, education_level, language, goals) values
    ('11111111-1111-1111-1111-111111111111', 'Aarav Mehta', '15-18', 'Grade 10', 'en', array['Improve at Python']),
    ('22222222-2222-2222-2222-222222222222', 'Diya Kapoor', '11-14', 'Grade 8',  'en', array['Get better at Algebra']),
    ('33333333-3333-3333-3333-333333333333', 'Rohan Iyer',  '15-18', 'Grade 11', 'en', array['Prep for coding interviews']),
    ('44444444-4444-4444-4444-444444444444', 'Sneha Rao',   '6-10',  'Grade 5',  'en', array['Enjoy learning to code'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Quiz attempts + answers per student per topic.
--    Each attempt answers every question in that topic's quiz; correctness
--    is chosen to land close to the target accuracy noted per student.
-- ---------------------------------------------------------------------

-- helper: quiz ids
--   Loops             30000000-0000-0000-0000-000000000001  (5 questions, ids 41...1-5)
--   Functions         30000000-0000-0000-0000-000000000002  (4 questions, ids 42...1-4)
--   Recursion         30000000-0000-0000-0000-000000000003  (4 questions, ids 43...1-4)
--   Linear Equations  30000000-0000-0000-0000-000000000004  (5 questions, ids 44...1-5)

-- ===== Aarav — weak in Loops (~40%), fine elsewhere =====
insert into quiz_attempts (id, student_id, quiz_id, score, total, completed_at) values
('a1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','30000000-0000-0000-0000-000000000001',2,5, now() - interval '9 days'),
('a1000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','30000000-0000-0000-0000-000000000001',2,5, now() - interval '1 days'),
('a1000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','30000000-0000-0000-0000-000000000002',3,4, now() - interval '3 days'),
('a1000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','30000000-0000-0000-0000-000000000004',5,5, now() - interval '6 days')
on conflict (id) do nothing;

insert into answers (attempt_id, question_id, selected_answer, correct) values
('a1000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000001','0 1 2',true),
('a1000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000002','while',false),
('a1000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000003','Skips to the next iteration',false),
('a1000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000004','5',true),
('a1000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000005','Too many variables',false),
('a1000000-0000-0000-0000-000000000002','41000000-0000-0000-0000-000000000001','1 2 3',false),
('a1000000-0000-0000-0000-000000000002','41000000-0000-0000-0000-000000000002','do-while',true),
('a1000000-0000-0000-0000-000000000002','41000000-0000-0000-0000-000000000003','Restarts the loop',false),
('a1000000-0000-0000-0000-000000000002','41000000-0000-0000-0000-000000000004','4',false),
('a1000000-0000-0000-0000-000000000002','41000000-0000-0000-0000-000000000005','A condition that never becomes false',true),
('a1000000-0000-0000-0000-000000000003','42000000-0000-0000-0000-000000000001','def',true),
('a1000000-0000-0000-0000-000000000003','42000000-0000-0000-0000-000000000002','None',true),
('a1000000-0000-0000-0000-000000000003','42000000-0000-0000-0000-000000000003','Global variable',false),
('a1000000-0000-0000-0000-000000000003','42000000-0000-0000-0000-000000000004','Reusability and clarity',true),
('a1000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000001','3',true),
('a1000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000002','The slope',true),
('a1000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000003','4',true),
('a1000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000004','Where the line crosses the x-axis',true),
('a1000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000005','The same slope',true)
on conflict do nothing;

insert into mistakes (student_id, topic, error_type, question_id, count) values
('11111111-1111-1111-1111-111111111111','Loops','conceptual','41000000-0000-0000-0000-000000000002',2),
('11111111-1111-1111-1111-111111111111','Loops','conceptual','41000000-0000-0000-0000-000000000003',1),
('11111111-1111-1111-1111-111111111111','Loops','careless','41000000-0000-0000-0000-000000000004',1),
('11111111-1111-1111-1111-111111111111','Functions','conceptual','42000000-0000-0000-0000-000000000003',1)
on conflict do nothing;

-- ===== Diya — weak in Linear Equations (~30%), fine elsewhere =====
insert into quiz_attempts (id, student_id, quiz_id, score, total, completed_at) values
('a2000000-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','30000000-0000-0000-0000-000000000004',1,5, now() - interval '8 days'),
('a2000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','30000000-0000-0000-0000-000000000004',2,5, now() - interval '1 days'),
('a2000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','30000000-0000-0000-0000-000000000001',4,5, now() - interval '2 days'),
('a2000000-0000-0000-0000-000000000004','22222222-2222-2222-2222-222222222222','30000000-0000-0000-0000-000000000002',4,4, now() - interval '5 days')
on conflict (id) do nothing;

insert into answers (attempt_id, question_id, selected_answer, correct) values
('a2000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000001','2',false),
('a2000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000002','The y-intercept',false),
('a2000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000003','3',false),
('a2000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000004','Where the line crosses the x-axis',true),
('a2000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000005','Opposite slopes',false),
('a2000000-0000-0000-0000-000000000002','44000000-0000-0000-0000-000000000001','5',false),
('a2000000-0000-0000-0000-000000000002','44000000-0000-0000-0000-000000000002','The slope',true),
('a2000000-0000-0000-0000-000000000002','44000000-0000-0000-0000-000000000003','6',false),
('a2000000-0000-0000-0000-000000000002','44000000-0000-0000-0000-000000000004','The slope',false),
('a2000000-0000-0000-0000-000000000002','44000000-0000-0000-0000-000000000005','The same slope',true),
('a2000000-0000-0000-0000-000000000003','41000000-0000-0000-0000-000000000001','0 1 2',true),
('a2000000-0000-0000-0000-000000000003','41000000-0000-0000-0000-000000000002','do-while',true),
('a2000000-0000-0000-0000-000000000003','41000000-0000-0000-0000-000000000003','Exits the loop immediately',true),
('a2000000-0000-0000-0000-000000000003','41000000-0000-0000-0000-000000000004','6',false),
('a2000000-0000-0000-0000-000000000003','41000000-0000-0000-0000-000000000005','A condition that never becomes false',true),
('a2000000-0000-0000-0000-000000000004','42000000-0000-0000-0000-000000000001','def',true),
('a2000000-0000-0000-0000-000000000004','42000000-0000-0000-0000-000000000002','None',true),
('a2000000-0000-0000-0000-000000000004','42000000-0000-0000-0000-000000000003','Default parameter',true),
('a2000000-0000-0000-0000-000000000004','42000000-0000-0000-0000-000000000004','Reusability and clarity',true)
on conflict do nothing;

insert into mistakes (student_id, topic, error_type, question_id, count) values
('22222222-2222-2222-2222-222222222222','Linear Equations','conceptual','44000000-0000-0000-0000-000000000001',2),
('22222222-2222-2222-2222-222222222222','Linear Equations','conceptual','44000000-0000-0000-0000-000000000002',1),
('22222222-2222-2222-2222-222222222222','Linear Equations','calculation','44000000-0000-0000-0000-000000000003',2),
('22222222-2222-2222-2222-222222222222','Linear Equations','conceptual','44000000-0000-0000-0000-000000000005',1)
on conflict do nothing;

-- ===== Rohan — strong across the board (~90%+) =====
insert into quiz_attempts (id, student_id, quiz_id, score, total, completed_at) values
('a3000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','30000000-0000-0000-0000-000000000001',5,5, now() - interval '7 days'),
('a3000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','30000000-0000-0000-0000-000000000002',4,4, now() - interval '5 days'),
('a3000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','30000000-0000-0000-0000-000000000003',4,4, now() - interval '2 days'),
('a3000000-0000-0000-0000-000000000004','33333333-3333-3333-3333-333333333333','30000000-0000-0000-0000-000000000004',5,5, now() - interval '1 days')
on conflict (id) do nothing;

insert into answers (attempt_id, question_id, selected_answer, correct) values
('a3000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000001','0 1 2',true),
('a3000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000002','do-while',true),
('a3000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000003','Exits the loop immediately',true),
('a3000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000004','5',true),
('a3000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000005','A condition that never becomes false',true),
('a3000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000001','def',true),
('a3000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000002','None',true),
('a3000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000003','Default parameter',true),
('a3000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000004','Reusability and clarity',true),
('a3000000-0000-0000-0000-000000000003','43000000-0000-0000-0000-000000000001','A base case',true),
('a3000000-0000-0000-0000-000000000003','43000000-0000-0000-0000-000000000002','6',true),
('a3000000-0000-0000-0000-000000000003','43000000-0000-0000-0000-000000000003','The call stack',true),
('a3000000-0000-0000-0000-000000000003','43000000-0000-0000-0000-000000000004','A stack overflow / crash',true),
('a3000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000001','3',true),
('a3000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000002','The slope',true),
('a3000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000003','4',true),
('a3000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000004','Where the line crosses the x-axis',true),
('a3000000-0000-0000-0000-000000000004','44000000-0000-0000-0000-000000000005','The same slope',true)
on conflict do nothing;

-- ===== Sneha — young learner, mostly solid, a couple of slips =====
insert into quiz_attempts (id, student_id, quiz_id, score, total, completed_at) values
('a4000000-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','30000000-0000-0000-0000-000000000001',4,5, now() - interval '4 days'),
('a4000000-0000-0000-0000-000000000002','44444444-4444-4444-4444-444444444444','30000000-0000-0000-0000-000000000002',3,4, now() - interval '1 days')
on conflict (id) do nothing;

insert into answers (attempt_id, question_id, selected_answer, correct) values
('a4000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000001','0 1 2',true),
('a4000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000002','do-while',true),
('a4000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000003','Skips to the next iteration',false),
('a4000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000004','5',true),
('a4000000-0000-0000-0000-000000000001','41000000-0000-0000-0000-000000000005','A condition that never becomes false',true),
('a4000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000001','def',true),
('a4000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000002','an error',false),
('a4000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000003','Default parameter',true),
('a4000000-0000-0000-0000-000000000002','42000000-0000-0000-0000-000000000004','Reusability and clarity',true)
on conflict do nothing;

insert into mistakes (student_id, topic, error_type, question_id, count) values
('44444444-4444-4444-4444-444444444444','Loops','careless','41000000-0000-0000-0000-000000000003',1),
('44444444-4444-4444-4444-444444444444','Functions','conceptual','42000000-0000-0000-0000-000000000002',1)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 3. Real Supabase Auth logins (same ids as the profiles above), so every
--    demo student can sign in through the app's normal login screen and
--    RLS applies with zero workarounds.
-- ---------------------------------------------------------------------
insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
) values
    ('00000000-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111',
     'authenticated', 'authenticated', 'aarav@demo.com', crypt('Demo@123', gen_salt('bf')),
     now(), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
     'authenticated', 'authenticated', 'diya@demo.com', crypt('Demo@123', gen_salt('bf')),
     now(), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333',
     'authenticated', 'authenticated', 'rohan@demo.com', crypt('Demo@123', gen_salt('bf')),
     now(), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''),
    ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444',
     'authenticated', 'authenticated', 'sneha@demo.com', crypt('Demo@123', gen_salt('bf')),
     now(), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select uuid_generate_v4(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email),
       'email', now(), now(), now()
from auth.users u
where u.id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
               '33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 4. Restore the profiles -> auth.users foreign key now that matching
--    auth.users rows exist.
-- ---------------------------------------------------------------------
alter table profiles add constraint profiles_id_fkey foreign key (id) references auth.users(id) on delete cascade;

-- =====================================================================
-- DEMO LOGIN CREDENTIALS
--  Aarav Mehta   aarav@demo.com   Demo@123   Weak in Loops (~40%)
--  Diya Kapoor   diya@demo.com    Demo@123   Weak in Linear Equations (~30%)
--  Rohan Iyer    rohan@demo.com   Demo@123   Strong across the board (~95%)
--  Sneha Rao     sneha@demo.com   Demo@123   Mostly solid, a couple of slips
-- =====================================================================
-- Run the agent once per student after seeding, e.g. via the frontend's
-- "Re-run cycle" button (or POST /functions/v1/agent-cycle), so each demo
-- account already has a recommendation and an agent_runs entry to show.
