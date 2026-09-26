'use client';

import { useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import {
  Alert,
  Badge,
  Button,
  Card,
  Choice,
  DataTable,
  EmptyState,
  Field,
  FileUpload,
  Header,
  Input,
  KpiCard,
  Modal,
  Progress,
  SearchInput,
  Select,
  Sidebar,
  Skeleton,
  Textarea,
  Toggle,
} from './design-system';

export function DesignSystemShowcase({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const [modalOpen, setModalOpen] = useState(false);
  const t = createTranslator(locale);
  return (
    <main className="showcase" id="showcase">
      <div className="showcase__intro">
        <h1>{t('showcase.title')}</h1>
        <p>{t('showcase.description')}</p>
      </div>
      <section className="showcase__section">
        <h2>{t('showcase.buttons')}</h2>
        <div className="button-row">
          <Button>{t('action.save')}</Button>
          <Button variant="secondary">{t('action.cancel')}</Button>
          <Button variant="ghost">{t('action.retry')}</Button>
          <Button variant="destructive">{t('action.close')}</Button>
          <Button loading>{t('action.save')}</Button>
        </div>
      </section>
      <section className="showcase__section">
        <h2>{t('showcase.inputs')}</h2>
        <div className="component-grid">
          <Field label={t('showcase.label_name')} required helper={t('showcase.helper_name')}>
            <Input placeholder={t('showcase.placeholder_name')} required />
          </Field>
          <Field label={t('showcase.label_search')}>
            <SearchInput
              clearLabel={t('showcase.clear_search')}
              placeholder={t('showcase.label_search')}
            />
          </Field>
          <Field label={t('showcase.label_department')}>
            <Select defaultValue="">
              <option value="" disabled>
                {t('showcase.label_department')}
              </option>
              <option>{t('showcase.department_hr')}</option>
              <option>{t('showcase.department_finance')}</option>
            </Select>
          </Field>
          <Field label={t('showcase.label_notes')}>
            <Textarea />
          </Field>
          <Toggle label={t('showcase.label_active')} />
          <Choice type="checkbox" label={t('showcase.label_notify')} />
          <FileUpload label={t('showcase.label_file')} hint={t('showcase.file_hint')} />
        </div>
      </section>
      <section className="showcase__section">
        <h2>{t('showcase.cards')}</h2>
        <div className="component-grid">
          <KpiCard label={t('showcase.kpi_label')} value="128" delta={t('showcase.kpi_delta')} />
          <Card title={t('showcase.cards')}>
            <Progress value={72} label={t('showcase.cards')} />
          </Card>
        </div>
      </section>
      <section className="showcase__section">
        <h2>{t('showcase.table')}</h2>
        <DataTable
          headers={[t('showcase.table_name'), t('showcase.status'), t('showcase.table_amount')]}
          rows={[
            [
              t('showcase.label_name'),
              <Badge tone="success" key="one">
                {t('showcase.status_paid')}
              </Badge>,
              <span className="ltr-value" key="two">
                20,000 EGP
              </span>,
            ],
            [
              t('showcase.department_hr'),
              <Badge tone="warning" key="three">
                {t('showcase.status_pending')}
              </Badge>,
              <span className="ltr-value" key="four">
                8,500 EGP
              </span>,
            ],
          ]}
        />
      </section>
      <section className="showcase__section">
        <h2>{t('showcase.states')}</h2>
        <div className="component-grid">
          <Card title={t('state.loading')}>
            <Skeleton />
          </Card>
          <Card title={t('state.empty')}>
            <EmptyState
              title={t('showcase.empty_title')}
              description={t('showcase.empty_description')}
              action={<Button>{t('showcase.add')}</Button>}
            />
          </Card>
          <Alert tone="success" title={t('showcase.alert_title')}>
            {t('showcase.alert_body')}
          </Alert>
          <Alert tone="danger" title={t('state.error')}>
            {t('action.retry')}
          </Alert>
        </div>
      </section>
      <section className="showcase__section">
        <h2>{t('showcase.navigation')}</h2>
        <div className="component-grid">
          <Sidebar
            brand={t('app.name')}
            navigationLabel={t('showcase.navigation')}
            active={t('showcase.nav_overview')}
            items={[
              t('showcase.nav_overview'),
              t('showcase.nav_people'),
              t('showcase.nav_settings'),
            ]}
          />
          <Card>
            <Header context={t('showcase.context')} search={t('showcase.label_search')} />
          </Card>
        </div>
      </section>
      <section className="showcase__section">
        <h2>{t('showcase.modal')}</h2>
        <Button onClick={() => setModalOpen(true)}>{t('showcase.open_modal')}</Button>
        <Modal
          open={modalOpen}
          title={t('showcase.modal')}
          closeLabel={t('action.close')}
          onClose={() => setModalOpen(false)}
          footer={<Button onClick={() => setModalOpen(false)}>{t('action.close')}</Button>}
        >
          <p>{t('showcase.modal_body')}</p>
        </Modal>
      </section>
    </main>
  );
}
