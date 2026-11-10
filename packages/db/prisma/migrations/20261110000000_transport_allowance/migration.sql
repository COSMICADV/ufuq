-- Transport allowance — a second salary component, paid per office day.
--
-- employee_salaries.transport_allowance: the monthly allowance that row
-- grants, history like the salary itself (never updated in place).
-- payroll_lines.transport_allowance: what the month's office days earned —
-- the allowance ÷ the month's working days × office days. Working from home
-- and leave earn none.

ALTER TABLE "employee_salaries"
  ADD COLUMN "transport_allowance" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "employee_salaries_transport_non_negative" CHECK ("transport_allowance" >= 0);

ALTER TABLE "payroll_lines"
  ADD COLUMN "transport_allowance" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT "payroll_lines_transport_non_negative" CHECK ("transport_allowance" >= 0);

-- The history and lock guards now cover the new amounts too.
CREATE OR REPLACE FUNCTION "employee_salaries_guard_history"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only closing an open row is allowed: its amount, start, employee,
    -- policy and currency are history.
    IF NEW."monthly_salary" IS DISTINCT FROM OLD."monthly_salary"
       OR NEW."transport_allowance" IS DISTINCT FROM OLD."transport_allowance"
       OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
       OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."salary_policy_id" IS DISTINCT FROM OLD."salary_policy_id"
       OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
       OR NEW."note" IS DISTINCT FROM OLD."note"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'employee_salaries rows are history: only effective_to may be set'
        USING ERRCODE = '42501';
    END IF;
    IF OLD."effective_to" IS NOT NULL THEN
      RAISE EXCEPTION 'employee_salaries row % is already closed', OLD."id"
        USING ERRCODE = '42501';
    END IF;
  END IF;
  -- No two rows of one employee may overlap.
  IF EXISTS (
    SELECT 1 FROM "employee_salaries" s
    WHERE s."employee_id" = NEW."employee_id"
      AND s."id" <> NEW."id"
      AND s."effective_from" <= COALESCE(NEW."effective_to", DATE '9999-12-31')
      AND COALESCE(s."effective_to", DATE '9999-12-31') >= NEW."effective_from"
  ) THEN
    RAISE EXCEPTION 'employee_salaries rows of one employee may not overlap'
      USING ERRCODE = '23P01', CONSTRAINT = 'employee_salaries_no_overlap';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "payroll_lines_guard_lock"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  period_status "payroll_period_status";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT p."status" INTO period_status FROM "payroll_periods" p WHERE p."id" = NEW."payroll_period_id";
    IF NEW."is_locked" OR period_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'payroll lines are created unlocked, in a draft period' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."is_locked" THEN
    RAISE EXCEPTION 'payroll line % is locked: finalized payroll is immutable', OLD."id"
      USING ERRCODE = '42501', HINT = 'Create a payroll adjustment instead.';
  END IF;
  SELECT p."status" INTO period_status FROM "payroll_periods" p WHERE p."id" = OLD."payroll_period_id";
  IF TG_OP = 'DELETE' THEN
    IF period_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'payroll line % can only be removed from a draft period', OLD."id"
        USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."is_locked" THEN
    IF period_status IS DISTINCT FROM 'approved'
       OR NEW."payroll_period_id" IS DISTINCT FROM OLD."payroll_period_id"
       OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
       OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
       OR NEW."base_salary" IS DISTINCT FROM OLD."base_salary"
       OR NEW."transport_allowance" IS DISTINCT FROM OLD."transport_allowance"
       OR NEW."daily_wage" IS DISTINCT FROM OLD."daily_wage"
       OR NEW."working_days" IS DISTINCT FROM OLD."working_days"
       OR NEW."present_days" IS DISTINCT FROM OLD."present_days"
       OR NEW."wfh_days" IS DISTINCT FROM OLD."wfh_days"
       OR NEW."absent_days" IS DISTINCT FROM OLD."absent_days"
       OR NEW."paid_leave_days" IS DISTINCT FROM OLD."paid_leave_days"
       OR NEW."unpaid_leave_days" IS DISTINCT FROM OLD."unpaid_leave_days"
       OR NEW."late_minutes_total" IS DISTINCT FROM OLD."late_minutes_total"
       OR NEW."attendance_adjustment" IS DISTINCT FROM OLD."attendance_adjustment"
       OR NEW."total_deductions" IS DISTINCT FROM OLD."total_deductions"
       OR NEW."total_bonuses" IS DISTINCT FROM OLD."total_bonuses"
       OR NEW."net_salary" IS DISTINCT FROM OLD."net_salary"
       OR NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'payroll line % can only be locked unchanged, by finalizing an approved period', OLD."id"
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF period_status NOT IN ('draft', 'under_review') THEN
    RAISE EXCEPTION 'payroll line % is not editable while its period is %', OLD."id", period_status
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
