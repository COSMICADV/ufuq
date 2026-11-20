'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, sendNoContent } from '../../../lib/api-client';
import { categoryLabel } from '../../../lib/finance';
import type { Category } from '../../../lib/finance';
import { Button, Field, Input, Modal, Select } from '../../design-system';
import { ExpensesHeader } from './finance-parts';

type Kind = 'expense' | 'income';

/** Expense and income categories: the defaults, the person's own, and subcategories. */
export function CategoriesScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [kind, setKind] = useState<Kind>('expense');
  const [categories, setCategories] = useState<readonly Category[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<{ category: Category | null; parentId: string } | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      setCategories(await fetchOne<Category[]>('/personal/finance/categories', { locale }));
    } catch {
      setFailed(true);
    }
  }, [locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const own = (categories ?? []).filter((c) => c.kind === kind);
  const parents = own.filter((c) => c.parent_id === null);

  const open = (category: Category | null, parent = ''): void => {
    setError('');
    setEditing({ category, parentId: parent });
    setName(category ? categoryLabel(category, t) : '');
    setParentId(category ? (category.parent_id ?? '') : parent);
  };

  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!editing) return;
    if (!name.trim()) {
      setError(t('finance.category.name'));
      return;
    }
    setSaving(true);
    try {
      if (editing.category) {
        await fetchOne(`/personal/finance/categories/${editing.category.id}`, {
          locale,
          method: 'PATCH',
          body: { name: name.trim() },
        });
      } else {
        await fetchOne('/personal/finance/categories', {
          locale,
          method: 'POST',
          body: { kind, name: name.trim(), ...(parentId ? { parent_id: parentId } : {}) },
        });
      }
      setEditing(null);
      await load();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.fields['name'] ? t('finance.error.name') : t('finance.error.generic'),
      );
    } finally {
      setSaving(false);
    }
  };

  const archive = async (category: Category): Promise<void> => {
    await fetchOne(`/personal/finance/categories/${category.id}`, { locale, method: 'DELETE' });
    await load();
  };
  const restore = async (category: Category): Promise<void> => {
    await sendNoContent(`/personal/finance/categories/${category.id}/restore`, { locale, method: 'POST' });
    await load();
  };

  const row = (category: Category, sub: boolean): React.JSX.Element => (
    <li key={category.id} className={`fin-cat-row${sub ? ' is-sub' : ''}${category.archived ? ' is-archived' : ''}`}>
      <span className="fin-cat-row__name">
        {categoryLabel(category, t)}
        {category.archived ? <span className="fin-archived">{t('finance.category.archived')}</span> : null}
      </span>
      <span className="fin-cat-row__actions">
        {category.archived ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void restore(category);
            }}
          >
            {t('finance.category.restore')}
          </Button>
        ) : (
          <>
            {sub ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  open(null, category.id);
                }}
              >
                + {t('finance.category.add_sub')}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                open(category);
              }}
            >
              {t('finance.category.rename')}
            </Button>
            <Button
              size="sm"
              variant="destructive-ghost"
              onClick={() => {
                void archive(category);
              }}
            >
              {t('finance.category.archive')}
            </Button>
          </>
        )}
      </span>
    </li>
  );

  return (
    <div className="pscreen fin">
      <ExpensesHeader
        locale={locale}
        action={
          <Button
            onClick={() => {
              open(null);
            }}
          >
            + {t('finance.category.add')}
          </Button>
        }
      />
      <div className="fin-periods" role="tablist">
        {(['expense', 'income'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={kind === value}
            className="fin-chip"
            onClick={() => {
              setKind(value);
            }}
          >
            {t(`finance.category.${value}`)}
          </button>
        ))}
      </div>
      {failed ? (
        <div className="pempty" role="alert">
          <p>{t('finance.error.load')}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void load();
            }}
          >
            {t('finance.retry')}
          </Button>
        </div>
      ) : categories === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : (
        <ul className="fin-card fin-cat-list">
          {parents.flatMap((parent) => [
            row(parent, false),
            ...own.filter((c) => c.parent_id === parent.id).map((c) => row(c, true)),
          ])}
        </ul>
      )}

      <Modal
        open={editing !== null}
        title={
          editing?.category
            ? t('finance.category.rename')
            : editing?.parentId
              ? t('finance.category.add_sub')
              : t('finance.category.add')
        }
        closeLabel={t('finance.close')}
        onClose={() => {
          setEditing(null);
        }}
      >
        <form
          className="fin-form"
          noValidate
          onSubmit={(event) => {
            void save(event);
          }}
        >
          <Field label={t('finance.category.name')} required {...(error ? { error } : {})}>
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>
          {editing?.category ? null : (
            <Field label={t('finance.category.parent')}>
              <Select
                value={parentId}
                onChange={(event) => {
                  setParentId(event.target.value);
                }}
              >
                <option value="">{t('finance.category.none')}</option>
                {parents
                  .filter((p) => !p.archived)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {categoryLabel(p, t)}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          <div className="fin-form__actions">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(null);
              }}
            >
              {t('finance.cancel')}
            </Button>
            <Button type="submit" loading={saving}>
              {t('finance.save')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
