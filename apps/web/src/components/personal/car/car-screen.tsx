'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ApiError, fetchOne, sendNoContent } from '../../../lib/api-client';
import { dayTime, MIN_READINGS, MIN_SPAN_DAYS } from '../../../lib/car';
import type { OdometerReading, Vehicle } from '../../../lib/car';
import { groupKm } from '../../../lib/odometer-reader';
import { StoredReceipt } from '../../capture/receipt-thumbs';
import { Button, Field, Input, Modal } from '../../design-system';
import { FreehandIcon } from '../../freehand-icon';
import { PersonalIcon } from '../personal-shell';
import { ReadingDialog } from './reading-dialog';

interface VehicleDraft {
  name: string;
  make: string;
  model: string;
  year: string;
  plate: string;
  currentKm: string;
}

const EMPTY: VehicleDraft = { name: '', make: '', model: '', year: '', plate: '', currentKm: '' };

/**
 * My Car: the vehicles, each vehicle's confirmed odometer, the driving
 * pattern learnt from real readings, and the reading history. Maintenance
 * predictions arrive in phase B and use the same readings.
 */
export function CarScreen({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [vehicles, setVehicles] = useState<readonly Vehicle[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Vehicle | null>(null);
  const [failed, setFailed] = useState(false);
  const [vehicleForm, setVehicleForm] = useState<{ editing: Vehicle | null; draft: VehicleDraft } | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [readingDialog, setReadingDialog] = useState<{ open: boolean; editing: OdometerReading | null; camera: boolean }>({
    open: false,
    editing: null,
    camera: false,
  });
  const [removing, setRemoving] = useState<OdometerReading | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setFailed(false);
      const list = await fetchOne<Vehicle[]>('/personal/car/vehicles', { locale });
      setVehicles(list);
      const id = selected && list.some((v) => v.id === selected) ? selected : (list[0]?.id ?? null);
      setSelected(id);
      setDetail(id ? await fetchOne<Vehicle>(`/personal/car/vehicles/${id}`, { locale }) : null);
    } catch {
      setFailed(true);
    }
  }, [locale, selected]);

  useEffect(() => {
    void load();
  }, [load]);

  const openVehicleForm = (editing: Vehicle | null): void => {
    setFormError('');
    setVehicleForm({
      editing,
      draft: editing
        ? {
            name: editing.name,
            make: editing.make ?? '',
            model: editing.model ?? '',
            year: editing.year ? String(editing.year) : '',
            plate: editing.plate ?? '',
            currentKm: '',
          }
        : EMPTY,
    });
  };

  const saveVehicle = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!vehicleForm) return;
    const d = vehicleForm.draft;
    if (!d.name.trim()) {
      setFormError(t('car.error.name'));
      return;
    }
    if (d.year && !/^\d{4}$/.test(d.year)) {
      setFormError(t('car.error.year'));
      return;
    }
    if (d.currentKm && !/^\d{1,7}$/.test(d.currentKm.replace(/[,\s]/g, ''))) {
      setFormError(t('car.error.km'));
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: d.name.trim(),
        make: d.make.trim(),
        model: d.model.trim(),
        plate: d.plate.trim(),
        ...(d.year ? { year: Number(d.year) } : {}),
      };
      const saved = vehicleForm.editing
        ? await fetchOne<Vehicle>(`/personal/car/vehicles/${vehicleForm.editing.id}`, { locale, method: 'PATCH', body })
        : await fetchOne<Vehicle>('/personal/car/vehicles', {
            locale,
            method: 'POST',
            body: { ...body, ...(d.currentKm ? { current_km: Number(d.currentKm.replace(/[,\s]/g, '')) } : {}) },
          });
      setVehicleForm(null);
      setSelected(saved.id);
      await load();
    } catch (error) {
      setFormError(error instanceof ApiError && error.fields['name'] ? t('car.error.name_taken') : t('finance.error.generic'));
    } finally {
      setSaving(false);
    }
  };

  const archiveVehicle = async (vehicle: Vehicle): Promise<void> => {
    await fetchOne(`/personal/car/vehicles/${vehicle.id}`, { locale, method: 'DELETE' });
    setVehicleForm(null);
    setSelected(null);
    await load();
  };

  const removeReading = async (): Promise<void> => {
    if (!removing) return;
    try {
      await sendNoContent(`/personal/car/readings/${removing.id}`, { locale, method: 'DELETE' });
      setRemoving(null);
      await load();
    } catch {
      setRemoving(null);
    }
  };

  const stats = detail?.stats;
  const readings = detail?.readings ?? [];

  return (
    <div className="pscreen fin car">
      <div className="fin-head">
        <header className="pscreen-head">
          <PersonalIcon entry="car" size={64} />
          <div>
            <h1>{t('personal.nav.car')}</h1>
            <p>{t('personal.about.car')}</p>
          </div>
          {detail ? (
            <div className="fin-head__action">
              <Button
                variant="secondary"
                onClick={() => {
                  setReadingDialog({ open: true, editing: null, camera: false });
                }}
              >
                {t('car.add_manual')}
              </Button>
              <Button
                onClick={() => {
                  setReadingDialog({ open: true, editing: null, camera: true });
                }}
              >
                {t('car.take_photo')}
              </Button>
            </div>
          ) : null}
        </header>
        {vehicles && vehicles.length > 0 ? (
          <div className="fin-periods car-vehicles" role="tablist" aria-label={t('car.vehicles')}>
            {vehicles.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                className="fin-chip"
                aria-selected={v.id === selected}
                onClick={() => {
                  setSelected(v.id);
                }}
              >
                {v.name}
              </button>
            ))}
            <button
              type="button"
              className="fin-chip car-add-vehicle"
              onClick={() => {
                openVehicleForm(null);
              }}
            >
              + {t('car.add_vehicle')}
            </button>
          </div>
        ) : null}
      </div>

      {failed ? (
        <div className="pempty" role="alert">
          <p>{t('car.error.load')}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void load();
            }}
          >
            {t('finance.retry')}
          </Button>
        </div>
      ) : vehicles === null ? (
        <div className="fin-loading" aria-busy="true" />
      ) : vehicles.length === 0 ? (
        <section className="fin-card car-empty">
          <h2>{t('car.empty_title')}</h2>
          <p className="fin-muted">{t('car.empty_help')}</p>
          <Button
            onClick={() => {
              openVehicleForm(null);
            }}
          >
            {t('car.add_vehicle')}
          </Button>
        </section>
      ) : detail && stats ? (
        <>
          {stats.stale ? (
            <div className="budget-alert car-stale" role="status">
              <span>{t('car.stale', { days: String(stats.days_since_last ?? 0) })}</span>
              <Button
                size="sm"
                onClick={() => {
                  setReadingDialog({ open: true, editing: null, camera: true });
                }}
              >
                {t('car.take_photo')}
              </Button>
            </div>
          ) : null}

          <section className="car-kpis">
            <div className="fin-kpi fin-kpi--hero">
              <span>{t('car.current')}</span>
              <strong dir="ltr">{stats.current_km === null ? '—' : `${groupKm(stats.current_km)} ${t('car.km')}`}</strong>
              <small>
                {stats.last_read_at
                  ? t('car.last_read', { when: dayTime(stats.last_read_at, locale) })
                  : t('car.no_reading')}
              </small>
            </div>
            <div className="fin-kpi">
              <span>{t('car.daily')}</span>
              <strong dir="ltr">{stats.daily_km ? `${stats.daily_km} ${t('car.km')}` : '—'}</strong>
              {stats.trend ? (
                <small className={`car-trend car-trend--${stats.trend.direction}`}>
                  {t(`car.trend.${stats.trend.direction}`, { km: stats.trend.recent_daily_km })}
                </small>
              ) : null}
            </div>
            <div className="fin-kpi">
              <span>{t('car.monthly')}</span>
              <strong dir="ltr">{stats.monthly_km !== null ? `${groupKm(stats.monthly_km)} ${t('car.km')}` : '—'}</strong>
              {stats.status === 'ok' ? <small>{t('car.estimate_note')}</small> : null}
            </div>
          </section>

          {stats.status === 'insufficient' ? (
            <p className="fin-note">
              {stats.reason === 'need_days'
                ? t('car.need_days', { days: String(MIN_SPAN_DAYS), span: String(stats.span_days) })
                : t('car.need_readings', { min: String(MIN_READINGS), have: String(stats.readings_used) })}
            </p>
          ) : (
            <p className="fin-muted car-basis">
              {t('car.basis', { count: String(stats.readings_used), days: String(stats.span_days) })}
            </p>
          )}

          <div className="car-grid">
            <section className="fin-card" aria-labelledby="car-maintenance">
              <h2 id="car-maintenance">{t('car.maintenance_title')}</h2>
              <p className="fin-muted">{t('car.maintenance_soon')}</p>
            </section>

            <section className="fin-card car-vehicle" aria-labelledby="car-vehicle">
              <div className="fin-card__head">
                <h2 id="car-vehicle">{detail.name}</h2>
                <button
                  type="button"
                  className="car-link"
                  onClick={() => {
                    openVehicleForm(detail);
                  }}
                >
                  {t('car.edit_vehicle')}
                </button>
              </div>
              <dl>
                {(
                  [
                    ['make', [detail.make, detail.model].filter(Boolean).join(' ')],
                    ['year', detail.year ? String(detail.year) : ''],
                    ['plate', detail.plate ?? ''],
                  ] as const
                )
                  .filter(([, value]) => value)
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{t(`car.field.${key}`)}</dt>
                      <dd>
                        <bdi>{value}</bdi>
                      </dd>
                    </div>
                  ))}
              </dl>
            </section>
          </div>

          <section className="fin-card" aria-labelledby="car-history">
            <h2 id="car-history">{t('car.history')}</h2>
            {readings.length === 0 ? (
              <p className="fin-muted">{t('car.history_empty')}</p>
            ) : (
              <ul className="car-readings">
                {readings.map((r) => (
                  <li key={r.id} className={r.kind !== 'normal' ? 'is-reset' : ''}>
                    <span className="car-readings__icon" aria-hidden="true">
                      <FreehandIcon name={r.source === 'photo' ? 'search' : 'document'} size={20} />
                    </span>
                    <span className="car-readings__main">
                      <strong dir="ltr">
                        {groupKm(r.reading_km)} {t('car.km')}
                      </strong>
                      <small>
                        {[
                          dayTime(r.read_at, locale),
                          r.since_previous_km !== null ? t('car.since_previous', { km: groupKm(r.since_previous_km) }) : null,
                          r.source === 'photo' ? t('car.source.photo') : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </small>
                      <span className="car-readings__tags">
                        {r.kind !== 'normal' ? <span className="health-chip">{t(`car.kind.${r.kind}`)}</span> : null}
                        {r.corrected ? <span className="health-chip">{t('car.corrected')}</span> : null}
                        {r.unusual ? <span className="budget-state budget-state--warning">{t('car.unusual')}</span> : null}
                      </span>
                      {r.note ? <small className="car-readings__note">{r.note}</small> : null}
                    </span>
                    <span className="car-readings__actions">
                      {r.photo_ids[0] ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setPhoto(r.photo_ids[0] ?? null);
                          }}
                        >
                          {t('car.view_photo')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setReadingDialog({ open: true, editing: r, camera: false });
                        }}
                      >
                        {t('car.correct')}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive-ghost"
                        onClick={() => {
                          setRemoving(r);
                        }}
                      >
                        {t('finance.delete')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <div className="fin-loading" aria-busy="true" />
      )}

      {detail ? (
        <ReadingDialog
          locale={locale}
          open={readingDialog.open}
          vehicle={detail}
          editing={readingDialog.editing}
          withCamera={readingDialog.camera}
          onClose={() => {
            setReadingDialog({ open: false, editing: null, camera: false });
          }}
          onSaved={() => {
            void load();
          }}
        />
      ) : null}

      <Modal
        open={vehicleForm !== null}
        title={vehicleForm?.editing ? t('car.edit_vehicle') : t('car.add_vehicle')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setVehicleForm(null);
        }}
      >
        {vehicleForm ? (
          <form
            className="fin-form"
            noValidate
            onSubmit={(event) => {
              void saveVehicle(event);
            }}
          >
            {(['name', 'make', 'model', 'year', 'plate'] as const).map((key) => (
              <Field key={key} label={t(`car.field.${key}`)} required={key === 'name'}>
                <Input
                  value={vehicleForm.draft[key]}
                  maxLength={key === 'name' ? 80 : key === 'plate' ? 20 : key === 'year' ? 4 : 60}
                  inputMode={key === 'year' ? 'numeric' : undefined}
                  placeholder={key === 'name' ? t('car.field.name_hint') : undefined}
                  onChange={(event) => {
                    setVehicleForm({ ...vehicleForm, draft: { ...vehicleForm.draft, [key]: event.target.value } });
                  }}
                />
              </Field>
            ))}
            {vehicleForm.editing ? null : (
              <Field label={t('car.field.current_km')}>
                <Input
                  inputMode="numeric"
                  dir="ltr"
                  value={vehicleForm.draft.currentKm}
                  onChange={(event) => {
                    setVehicleForm({ ...vehicleForm, draft: { ...vehicleForm.draft, currentKm: event.target.value } });
                  }}
                />
              </Field>
            )}
            {formError ? (
              <p className="fin-form__error" role="alert">
                {formError}
              </p>
            ) : null}
            <div className="fin-form__actions">
              {vehicleForm.editing ? (
                <Button
                  type="button"
                  variant="destructive-ghost"
                  className="fin-form__delete"
                  onClick={() => {
                    if (vehicleForm.editing) void archiveVehicle(vehicleForm.editing);
                  }}
                >
                  {t('car.archive_vehicle')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setVehicleForm(null);
                }}
              >
                {t('finance.cancel')}
              </Button>
              <Button type="submit" loading={saving}>
                {t('finance.save')}
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={removing !== null}
        title={t('car.delete_reading')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setRemoving(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('finance.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void removeReading();
              }}
            >
              {t('finance.delete')}
            </Button>
          </>
        }
      >
        <p>{t('car.delete_reading_help', { km: removing ? groupKm(removing.reading_km) : '' })}</p>
      </Modal>

      <Modal
        open={photo !== null}
        title={t('car.photo_alt')}
        closeLabel={t('finance.close')}
        onClose={() => {
          setPhoto(null);
        }}
      >
        {photo ? (
          <div className="car-photo-view">
            <StoredReceipt locale={locale} receipt={{ id: photo, original_name: 'odometer.jpg', mime_type: 'image/jpeg', size_bytes: 0 }} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
