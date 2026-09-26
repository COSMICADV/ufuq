'use client';

import { useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructive-ghost';
type Size = 'sm' | 'md' | 'lg';

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: Size;
  readonly loading?: boolean;
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={`button button--${variant} button--${size} ${className}`}
      disabled={props.disabled || loading}
      aria-busy={loading}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Field({
  label,
  required,
  helper,
  error,
  children,
}: {
  readonly label: string;
  readonly required?: boolean;
  readonly helper?: string;
  readonly error?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </span>
      {typeof children === 'object' && children !== null ? (
        <span className="field__control">{children}</span>
      ) : (
        children
      )}
      {helper ? <span className="field__helper">{helper}</span> : null}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...props} className={`input ${props.className ?? ''}`} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} className={`input ${props.className ?? ''}`} />;
}
export function Textarea({
  className = '',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...props} className={`input textarea ${className}`} />;
}
export function SearchInput({
  clearLabel,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly clearLabel: string }): React.JSX.Element {
  const [value, setValue] = useState(props.defaultValue?.toString() ?? '');
  return (
    <span className="search">
      <Input
        {...props}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          props.onChange?.(event);
        }}
      />
      {value ? (
        <button
          type="button"
          className="icon-button"
          onClick={() => setValue('')}
          aria-label={clearLabel}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
export function Toggle({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { readonly label: string }): React.JSX.Element {
  return (
    <label className="toggle">
      <input {...props} type="checkbox" />
      <span aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
export function Choice({
  type,
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly type: 'checkbox' | 'radio';
  readonly label: string;
}): React.JSX.Element {
  return (
    <label className="choice">
      <input {...props} type={type} />
      <span>{label}</span>
    </label>
  );
}
export function FileUpload({
  label,
  hint,
}: {
  readonly label: string;
  readonly hint: string;
}): React.JSX.Element {
  return (
    <label className="file-upload">
      <span>{label}</span>
      <input type="file" />
      <small>{hint}</small>
    </label>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
}: {
  readonly title?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}): React.JSX.Element {
  return (
    <section className={`card ${className}`}>
      {title ? (
        <header className="card__header">
          <h3>{title}</h3>
          {action}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}
export function KpiCard({
  label,
  value,
  delta,
}: {
  readonly label: string;
  readonly value: string;
  readonly delta: string;
}): React.JSX.Element {
  return (
    <Card className="kpi">
      <span className="kpi__label">{label}</span>
      <strong className="kpi__value" dir="ltr">
        {value}
      </strong>
      <span className="kpi__delta">{delta}</span>
    </Card>
  );
}

const badgeTone = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  wfh: 'wfh',
  cancelled: 'cancelled',
} as const;
export function Badge({
  tone = 'info',
  children,
}: {
  readonly tone?: keyof typeof badgeTone;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <span className={`badge badge--${badgeTone[tone]}`}>{children}</span>;
}

export function DataTable({
  headers,
  rows,
}: {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
}): React.JSX.Element {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Progress({
  value,
  label,
}: {
  readonly value: number;
  readonly label: string;
}): React.JSX.Element {
  return (
    <div className="progress" aria-label={label}>
      <span style={{ inlineSize: `${value}%` }} />
      <small>{value}%</small>
    </div>
  );
}
export function Alert({
  tone = 'info',
  title,
  children,
}: {
  readonly tone?: 'success' | 'warning' | 'danger' | 'info';
  readonly title: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <section className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      <span>{children}</span>
    </section>
  );
}
export function EmptyState({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description: string;
  readonly action: ReactNode;
}): React.JSX.Element {
  return (
    <section className="empty-state">
      <span aria-hidden="true">○</span>
      <h4>{title}</h4>
      <p>{description}</p>
      {action}
    </section>
  );
}
export function Skeleton({ lines = 3 }: { readonly lines?: number }): React.JSX.Element {
  return (
    <div className="skeleton" role="status">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} />
      ))}
    </div>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
  footer,
  closeLabel,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly closeLabel: string;
}): React.JSX.Element | null {
  if (!open) return null;
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label={closeLabel}>
            ×
          </button>
        </header>
        <div>{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </section>
    </div>
  );
}

export function Sidebar({
  items,
  active,
  brand,
  navigationLabel,
}: {
  readonly items: readonly string[];
  readonly active: string;
  readonly brand: string;
  readonly navigationLabel: string;
}): React.JSX.Element {
  return (
    <aside className="sidebar">
      <strong>{brand}</strong>
      <nav aria-label={navigationLabel}>
        {items.map((item) => (
          <a className={item === active ? 'is-active' : ''} href="#showcase" key={item}>
            {item}
          </a>
        ))}
      </nav>
      <small>{brand}</small>
    </aside>
  );
}
export function Header({
  context,
  search,
}: {
  readonly context: string;
  readonly search: string;
}): React.JSX.Element {
  return (
    <header className="app-header">
      <span>{context}</span>
      <SearchInput clearLabel="Clear search" placeholder={search} />
    </header>
  );
}
