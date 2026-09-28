-- =====================================================================
-- Learning content: 2 courses, 4 topics, one quiz per topic.
-- Run AFTER 03_question_metadata.sql.
-- Question wording matches frontend/index.html's QUIZ_BANK for Loops and
-- Functions, so a real backend and the offline demo behave identically.
-- =====================================================================

insert into courses (id, title, subject, level, description) values
    ('10000000-0000-0000-0000-000000000001', 'Python Fundamentals', 'Computer Science', 'beginner',
     'Core Python concepts: loops, functions and recursion.'),
    ('10000000-0000-0000-0000-000000000002', 'Algebra Basics', 'Mathematics', 'beginner',
     'Foundational algebra: variables, expressions and linear equations.')
on conflict (id) do nothing;

insert into lessons (id, course_id, title, content, order_index) values
    ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Loops', 'for and while loops, range(), break and continue.', 1),
    ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'Functions', 'def, parameters, default values, return.', 2),
    ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Recursion', 'Base cases, recursive calls, call stacks.', 3),
    ('20000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000002', 'Linear Equations', 'Solving for x, slope-intercept form, graphing lines.', 1)
on conflict (id) do nothing;

insert into quizzes (id, lesson_id, topic, difficulty) values
    ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Loops', 'medium'),
    ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Functions', 'medium'),
    ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', 'Recursion', 'medium'),
    ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'Linear Equations', 'medium')
on conflict (id) do nothing;

-- ---- Loops ------------------------------------------------------------
insert into questions (id, quiz_id, question, options, answer, concept, difficulty, explanation, error_category) values
('41000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 E'What will this print?\n\nfor i in range(3):\n    print(i)',
 '["0 1 2","1 2 3","0 1 2 3","3"]', '0 1 2', 'Loops', 'easy',
 'range(3) produces 0, 1, 2 — it stops before reaching 3.', 'conceptual'),
('41000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001',
 'Which loop is guaranteed to run its body at least once?',
 '["for","while","do-while","none of these"]', 'do-while', 'Loops', 'medium',
 'A do-while loop checks its condition after the first pass.', 'conceptual'),
('41000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001',
 'What does `break` do inside a loop?',
 '["Skips to the next iteration","Exits the loop immediately","Restarts the loop","Pauses the program"]',
 'Exits the loop immediately', 'Loops', 'easy', 'break exits the nearest enclosing loop right away.', 'conceptual'),
('41000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001',
 'How many times does `for i in range(5):` run?',
 '["4","5","6","Infinite"]', '5', 'Loops', 'easy', 'range(5) yields 5 values: 0..4.', 'calculation_error'),
('41000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000001',
 'What is an infinite loop usually caused by?',
 '["A missing return statement","A condition that never becomes false","Too many variables","Using range()"]',
 'A condition that never becomes false', 'Loops', 'medium', 'The loop keeps running because its exit condition is never met.', 'conceptual')
on conflict (id) do nothing;

-- ---- Functions ----------------------------------------------------------
insert into questions (id, quiz_id, question, options, answer, concept, difficulty, explanation, error_category) values
('42000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002',
 'What keyword defines a function in Python?', '["func","def","function","lambda"]', 'def',
 'Functions', 'easy', 'Python uses the def keyword to define a function.', 'conceptual'),
('42000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002',
 'What does a function return if it has no `return` statement?', '["0","an error","None","an empty string"]',
 'None', 'Functions', 'medium', 'A function with no return statement implicitly returns None.', 'conceptual'),
('42000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000002',
 'What is a parameter with a default value called?',
 '["Positional argument","Default parameter","Global variable","Return type"]', 'Default parameter',
 'Function Parameters', 'medium', 'def f(x=1) gives x a default value, making it optional.', 'conceptual'),
('42000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000002',
 'Why use functions instead of repeating code?',
 '["They run faster always","Reusability and clarity","They use less memory always","Python requires it"]',
 'Reusability and clarity', 'Functions', 'easy', 'Functions package logic so it can be reused and read clearly.', 'conceptual')
on conflict (id) do nothing;

-- ---- Recursion ------------------------------------------------------------
insert into questions (id, quiz_id, question, options, answer, concept, difficulty, explanation, error_category) values
('43000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003',
 'What stops a recursive function from running forever?', '["A for loop","A base case","A return type","A default parameter"]',
 'A base case', 'Recursion', 'easy', 'The base case is the condition where the function stops calling itself.', 'conceptual'),
('43000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000003',
 'What is the output of factorial(3) if factorial(n) = n * factorial(n-1), factorial(0)=1?',
 '["3","6","9","1"]', '6', 'Recursion', 'medium', '3 * 2 * 1 * factorial(0) = 3*2*1*1 = 6.', 'calculation_error'),
('43000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000003',
 'Each recursive call is added to what structure?', '["A queue","The call stack","A hash map","A linked list"]',
 'The call stack', 'Recursion', 'medium', 'Each call is pushed onto the call stack until a base case returns.', 'conceptual'),
('43000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000003',
 'What usually happens if a recursive function has no base case?', '["It runs once","A stack overflow / crash","It returns None","It runs faster"]',
 'A stack overflow / crash', 'Recursion', 'hard', 'Without a base case, calls never stop and the call stack overflows.', 'conceptual')
on conflict (id) do nothing;

-- ---- Linear Equations ------------------------------------------------------------
insert into questions (id, quiz_id, question, options, answer, concept, difficulty, explanation, error_category) values
('44000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000004',
 'Solve for x: 2x + 4 = 10', '["2","3","5","6"]', '3', 'Linear Equations', 'easy', '2x = 6, so x = 3.', 'calculation_error'),
('44000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000004',
 'In y = mx + b, what does m represent?', '["The y-intercept","The slope","The x-intercept","A constant term"]',
 'The slope', 'Linear Equations', 'medium', 'm is the slope, the rate of change of y with respect to x.', 'conceptual'),
('44000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000004',
 'Solve for x: 5x - 3 = 2x + 9', '["3","4","6","12"]', '4', 'Linear Equations', 'medium', '3x = 12, so x = 4.', 'calculation_error'),
('44000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000004',
 'What does the x-intercept represent on a line''s graph?', '["Where the line crosses the y-axis","Where the line crosses the x-axis","The slope","The midpoint"]',
 'Where the line crosses the x-axis', 'Linear Equations', 'easy', 'The x-intercept is the point where y = 0.', 'conceptual'),
('44000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000004',
 'Two lines are parallel when they have:', '["The same y-intercept","The same slope","Opposite slopes","No slope"]',
 'The same slope', 'Linear Equations', 'medium', 'Parallel lines never meet because they rise at the same rate.', 'conceptual')
on conflict (id) do nothing;
