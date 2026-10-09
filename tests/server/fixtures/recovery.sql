-- Additional synthetic records for all thirteen business tables. No real accounts.
INSERT INTO commands(id,user_id,cafe_id,scope,key,payload_hash) VALUES ('rehearsal-op','u1','a','test','rehearsal-key','synthetic');
INSERT INTO inventory_movements(cafe_id,dataset_id,id,created_by,updated_by,item_id,delta_hundredths,operation_id,kind) VALUES ('a','a-live','m1','u1','u1','i1',250,'rehearsal-op','opening');
INSERT INTO purchases(cafe_id,dataset_id,id,created_by,updated_by,business_date,item,amount) VALUES ('a','a-live','purchase1','u1','u1','2026-10-01','Synthetic beans',28000);
INSERT INTO expenses(cafe_id,dataset_id,id,created_by,updated_by,business_date,item,amount) VALUES ('a','a-live','expense1','u1','u1','2026-10-01','Synthetic fee',5000);
INSERT INTO other_incomes(cafe_id,dataset_id,id,created_by,updated_by,business_date,item,amount) VALUES ('a','a-live','income1','u1','u1','2026-10-01','Synthetic income',3000);
INSERT INTO payroll_settings(cafe_id,dataset_id,id,created_by,updated_by,employee_id,effective_from,weekly_hours,holiday_day,normal_days,calculation_start,calculation_end,threshold,cap_hours,max_weekly,average_weeks) VALUES ('a','a-live','p1','u1','u1','e1','2026-01-01',20,'일',5,'2026-01-01','2026-12-31',15,8,40,4);
INSERT INTO payroll_rates VALUES ('a','a-live','p1',2026,10000);
INSERT INTO work_logs(cafe_id,dataset_id,id,created_by,updated_by,employee_id,business_date,start_time,end_time,break_minutes) VALUES ('a','a-live','w1','u1','u1','e1','2026-10-01','09:00','13:00',0);
INSERT INTO weekly_confirmations(cafe_id,dataset_id,id,created_by,updated_by,employee_id,week_start,agreed_hours,confirmation) VALUES ('a','a-live','week1','u1','u1','e1','2026-09-28',20,'미확인');
INSERT INTO payroll_extras(cafe_id,dataset_id,id,created_by,updated_by,employee_id,month,amount) VALUES ('a','a-live','extra1','u1','u1','e1','2026-10',1000);
INSERT INTO sales_reconciliations(cafe_id,dataset_id,id,created_by,updated_by,month,reported) VALUES ('a','a-live','reconciliation1','u1','u1','2026-10',120000);
UPDATE employees SET linked_user_id='u1' WHERE cafe_id='a' AND dataset_id='a-live';
