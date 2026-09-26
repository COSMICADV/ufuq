/**
 * The permission catalogue — DOCUMENT 02 §4.
 *
 * `key` is the only thing authorization logic ever compares against. The
 * bilingual descriptions exist for the future settings/roles admin screen;
 * they carry no security weight (DOCUMENT 09 §5).
 *
 * This is the full V1 catalogue, seeded in Phase 3 even though most of the
 * modules it describes (tasks, payroll, warehouse …) do not exist until their
 * own phase. Roles are "named bundles of permissions stored as data" (DOCUMENT
 * 02 §2) — the catalogue is reference data, not a feature of any one module,
 * and seeding it once now means adding a role later is a data insert, not a
 * schema change.
 */

export interface PermissionDefinition {
  readonly key: string;
  readonly module: string;
  readonly descriptionAr: string;
  readonly descriptionEn: string;
}

function permission(
  key: string,
  module: string,
  descriptionEn: string,
  descriptionAr: string,
): PermissionDefinition {
  return { key, module, descriptionEn, descriptionAr };
}

export const PERMISSIONS: readonly PermissionDefinition[] = [
  // Employees
  permission('employee.view', 'employees', 'View employees', 'عرض الموظفين'),
  permission('employee.create', 'employees', 'Create an employee', 'إضافة موظف'),
  permission('employee.update', 'employees', 'Update an employee', 'تعديل بيانات موظف'),
  permission(
    'employee.deactivate',
    'employees',
    'Deactivate or reactivate an employee',
    'إيقاف أو تفعيل موظف',
  ),
  permission('employee.view_salary', 'employees', "View an employee's salary", 'عرض راتب الموظف'),
  permission('employee.set_salary', 'employees', "Set an employee's salary", 'تحديد راتب الموظف'),
  permission(
    'employee.assign_manager',
    'employees',
    "Assign an employee's manager",
    'تعيين مدير الموظف',
  ),

  // Attendance
  permission('attendance.check_in', 'attendance', 'Check in', 'تسجيل حضور'),
  permission('attendance.check_out', 'attendance', 'Check out', 'تسجيل انصراف'),
  permission('attendance.view', 'attendance', 'View attendance', 'عرض الحضور والانصراف'),
  permission('attendance.update', 'attendance', 'Correct an attendance record', 'تعديل سجل حضور'),
  permission(
    'attendance.request_correction',
    'attendance',
    'Request an attendance correction',
    'طلب تصحيح حضور',
  ),
  permission(
    'attendance.approve_correction',
    'attendance',
    'Approve or reject an attendance correction',
    'اعتماد أو رفض طلب تصحيح حضور',
  ),

  // Leave
  permission('leave.request', 'leave', 'Request leave', 'طلب إجازة'),
  permission('leave.view', 'leave', 'View leave requests and balances', 'عرض الإجازات والأرصدة'),
  permission('leave.approve', 'leave', 'Approve or reject leave', 'اعتماد أو رفض الإجازة'),
  permission('leave.configure_types', 'leave', 'Configure leave types', 'إعداد أنواع الإجازات'),
  permission('leave.adjust_balance', 'leave', 'Adjust a leave balance', 'تعديل رصيد الإجازة'),

  // Tasks
  permission('task.view', 'tasks', 'View tasks', 'عرض المهام'),
  permission('task.create', 'tasks', 'Create a task', 'إنشاء مهمة'),
  permission('task.update', 'tasks', 'Update a task', 'تعديل مهمة'),
  permission('task.delete', 'tasks', 'Delete a task', 'حذف مهمة'),
  permission('task.update_status', 'tasks', 'Change a task status', 'تغيير حالة المهمة'),
  permission('task.update_checklist', 'tasks', 'Update a task checklist', 'تعديل قائمة مهام فرعية'),
  permission(
    'task.add_progress_note',
    'tasks',
    'Add a task progress note',
    'إضافة ملاحظة تقدم للمهمة',
  ),

  // Goals
  permission('goal.view', 'goals', 'View goals', 'عرض الأهداف'),
  permission('goal.create', 'goals', 'Create a goal', 'إنشاء هدف'),
  permission('goal.update', 'goals', 'Update a goal', 'تعديل هدف'),
  permission('goal.update_progress', 'goals', 'Update goal progress', 'تحديث تقدم الهدف'),

  // Requests
  permission('request.create', 'requests', 'Submit a request', 'تقديم طلب'),
  permission('request.view', 'requests', 'View requests', 'عرض الطلبات'),
  permission('request.review', 'requests', 'Approve or reject a request', 'اعتماد أو رفض طلب'),
  permission('request.cancel', 'requests', 'Cancel a request', 'إلغاء طلب'),

  // Payroll
  permission('payroll.view', 'payroll', 'View payroll', 'عرض الرواتب'),
  permission('payroll.generate', 'payroll', 'Generate a payroll period', 'إنشاء دورة رواتب'),
  permission('payroll.add_deduction', 'payroll', 'Add a payroll deduction', 'إضافة خصم للراتب'),
  permission('payroll.add_bonus', 'payroll', 'Add a payroll bonus', 'إضافة مكافأة للراتب'),
  permission('payroll.approve', 'payroll', 'Approve a payroll period', 'اعتماد دورة الرواتب'),
  permission('payroll.finalize', 'payroll', 'Finalize a payroll period', 'إغلاق دورة الرواتب'),
  permission('payroll.mark_paid', 'payroll', 'Mark payroll as paid', 'تعليم الرواتب كمدفوعة'),
  permission('payroll.adjust', 'payroll', 'Adjust a finalized payroll line', 'تعديل سطر راتب مغلق'),

  // Warehouse & inventory
  permission('warehouse.view', 'warehouse', 'View warehouses', 'عرض المخازن'),
  permission('warehouse.manage', 'warehouse', 'Manage warehouses', 'إدارة المخازن'),
  permission('product.view', 'warehouse', 'View products', 'عرض المنتجات'),
  permission('product.create', 'warehouse', 'Create a product', 'إضافة منتج'),
  permission('product.update', 'warehouse', 'Update a product', 'تعديل منتج'),
  permission('stock.view', 'warehouse', 'View stock', 'عرض المخزون'),
  permission('stock.movement_create', 'warehouse', 'Record a stock movement', 'تسجيل حركة مخزون'),
  permission(
    'stock.transfer',
    'warehouse',
    'Transfer stock between warehouses',
    'نقل مخزون بين المخازن',
  ),

  // Reports
  permission('report.company', 'reports', 'View company-wide reports', 'عرض تقارير الشركة'),
  permission('report.team', 'reports', "View a manager's team reports", 'عرض تقارير الفريق'),
  permission(
    'report.employee_monthly',
    'reports',
    "View an employee's monthly report",
    'عرض التقرير الشهري للموظف',
  ),
  permission('report.export', 'reports', 'Export a report', 'تصدير تقرير'),

  // Settings & audit
  permission('settings.view', 'settings', 'View company settings', 'عرض إعدادات الشركة'),
  permission('settings.update', 'settings', 'Update company settings', 'تعديل إعدادات الشركة'),
  permission('settings.work_schedule', 'settings', 'Configure work schedules', 'إعداد جداول العمل'),
  permission(
    'settings.salary_policy',
    'settings',
    'Configure salary policies',
    'إعداد سياسات الرواتب',
  ),
  permission(
    'settings.performance_weights',
    'settings',
    'Configure performance weights',
    'إعداد أوزان تقييم الأداء',
  ),
  permission('audit.view', 'settings', 'View the audit log', 'عرض سجل التدقيق'),
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));

export function isPermissionKey(value: string): value is PermissionKey {
  return PERMISSION_KEY_SET.has(value);
}
