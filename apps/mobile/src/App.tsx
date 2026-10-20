import { colors, fontFamilies, spacing, typography } from '@ufuq/design-tokens';
import { createTranslator, DEFAULT_LOCALE, LOCALES } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useState } from 'react';
import {
  I18nManager,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  Alert,
  AppNavigation,
  Badge,
  Button,
  Card,
  Choice,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  Input,
  Progress,
  Skeleton,
  Toggle,
  TypographyProvider,
} from './design-system';
import { directionStyle, nextLocale } from './direction';

I18nManager.allowRTL(true);

/** Phase 2's native component catalogue, exercised in both supported locales. */
export function App(): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const t = createTranslator(locale);
  const { direction, writingDirection } = directionStyle(locale);
  const text = { writingDirection, fontFamily: fontFamilies[locale] };

  return (
    <TypographyProvider locale={locale}>
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={[styles.content, { direction }]}>
          <View style={styles.language}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('language.switch')}
              onPress={() => setLocale(nextLocale(locale, LOCALES))}
            >
              <Text style={[styles.languageText, text]}>
                {t(`language.${nextLocale(locale, LOCALES)}`)}
              </Text>
            </Pressable>
          </View>
          <Text style={[styles.title, text]}>{t('showcase.title')}</Text>
          <Text style={[styles.description, text]}>{t('showcase.description')}</Text>
          <Section title={t('showcase.buttons')} text={text}>
            <View style={styles.row}>
              <Button>{t('action.save')}</Button>
              <Button variant="secondary">{t('action.cancel')}</Button>
              <Button variant="ghost">{t('action.retry')}</Button>
              <Button variant="destructive">{t('action.close')}</Button>
            </View>
          </Section>
          <Section title={t('showcase.inputs')} text={text}>
            <Field label={t('showcase.label_name')} required helper={t('showcase.helper_name')}>
              <Input placeholder={t('showcase.placeholder_name')} />
            </Field>
            <Field label={t('showcase.label_notes')}>
              <Input placeholder={t('showcase.label_notes')} multiline />
            </Field>
            <Toggle label={t('showcase.label_active')} />
            <Choice label={t('showcase.label_notify')} />
          </Section>
          <Section title={t('showcase.cards')} text={text}>
            <Card title={t('showcase.kpi_label')}>
              <Text style={[styles.kpi, text]}>128</Text>
              <Text style={[styles.delta, text]}>{t('showcase.kpi_delta')}</Text>
              <Progress value={72} />
            </Card>
          </Section>
          <Section title={t('showcase.table')} text={text}>
            <DataTable
              headers={[t('showcase.table_name'), t('showcase.status'), t('showcase.table_amount')]}
              rows={[
                [t('showcase.label_name'), t('showcase.status_paid'), '20,000 EGP'],
                [t('showcase.department_hr'), t('showcase.status_pending'), '8,500 EGP'],
              ]}
            />
            <View style={styles.row}>
              <Badge tone="success">{t('showcase.status_paid')}</Badge>
              <Badge tone="warning">{t('showcase.status_pending')}</Badge>
              <Badge tone="danger">{t('showcase.status_absent')}</Badge>
            </View>
          </Section>
          <Section title={t('showcase.states')} text={text}>
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
            <Alert
              tone="success"
              title={t('showcase.alert_title')}
              body={t('showcase.alert_body')}
            />
            <Alert tone="danger" title={t('state.error')} body={t('action.retry')} />
          </Section>
          <Section title={t('showcase.navigation')} text={text}>
            <AppNavigation
              items={[
                t('showcase.nav_overview'),
                t('showcase.nav_people'),
                t('showcase.nav_settings'),
              ]}
            />
          </Section>
          <Section title={t('showcase.modal')} text={text}>
            <Button onPress={() => setDialogOpen(true)}>{t('showcase.open_modal')}</Button>
          </Section>
          <Dialog
            visible={dialogOpen}
            title={t('showcase.modal')}
            body={t('showcase.modal_body')}
            close={t('action.close')}
            onClose={() => setDialogOpen(false)}
          />
        </ScrollView>
      </SafeAreaView>
    </TypographyProvider>
  );
}

function Section({
  title,
  text,
  children,
}: {
  readonly title: string;
  readonly text: { readonly writingDirection: 'rtl' | 'ltr' };
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, text]}>{title}</Text>
      <View style={styles.stack}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  content: { gap: spacing[4], padding: spacing[4] },
  language: { alignItems: 'flex-end' },
  languageText: { color: colors.greenPrimary600, fontSize: typography.body, fontWeight: '600' },
  title: { color: colors.textPrimary, fontSize: 24, lineHeight: 31, fontWeight: '700' },
  description: { color: colors.textSecondary, fontSize: typography.body, lineHeight: 24 },
  section: { gap: spacing[3], marginTop: spacing[2] },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: typography.h2,
    lineHeight: 28,
    fontWeight: '600',
  },
  stack: { gap: spacing[4] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  kpi: {
    color: colors.textPrimary,
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  delta: { color: colors.greenPrimary500, fontSize: typography.caption },
});
