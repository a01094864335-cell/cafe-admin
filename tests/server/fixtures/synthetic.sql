INSERT INTO users(id,name,email) VALUES ('u1','가상 소유자','owner@example.invalid'),('u2','가상 관리자','admin@example.invalid'),('u3','가상 직원','staff@example.invalid');
INSERT INTO cafes(id,name) VALUES ('a','가상 카페 A'),('b','가상 카페 B');
INSERT INTO datasets(cafe_id,id,state) VALUES ('a','a-live','active'),('a','a-stage','staging'),('b','b-live','active');
UPDATE cafes SET active_dataset_id=id||'-live';
INSERT INTO memberships(id,cafe_id,user_id,role) VALUES ('ma1','a','u1','owner'),('ma2','a','u2','admin'),('mb1','b','u2','owner'),('mb2','b','u1','staff');
INSERT INTO employees(cafe_id,dataset_id,id,name,created_by,updated_by) VALUES ('a','a-live','e1','가상 직원','u1','u1'),('b','b-live','e2','가상 직원 B','u2','u2'),('a','a-stage','e3','가져오기 직원','u1','u1');
INSERT INTO sales(cafe_id,dataset_id,id,business_date,card,cash,transfer,created_by,updated_by) VALUES ('a','a-live','s1','2026-10-01',100000,20000,NULL,'u1','u1'),('a','a-stage','s2','2026-10-02',3000,0,NULL,'u1','u1'),('b','b-live','s3','2026-10-01',9000,NULL,NULL,'u2','u2');
INSERT INTO inventory_items(cafe_id,dataset_id,id,name,unit,quantity_hundredths,minimum_hundredths,cost,supplier,created_by,updated_by) VALUES ('a','a-live','i1','가상 원두','kg',250,300,10000,'가상 공급처','u1','u1');
