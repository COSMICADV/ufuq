import { colors, radii, spacing, typography } from '@ufuq/design-tokens';
import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal as NativeModal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'wfh' | 'cancelled';
const toneStyles: Record<
  Tone,
  { readonly background: string; readonly text: string; readonly border: string }
> = {
  success: {
    background: colors.successBackground,
    text: colors.successText,
    border: colors.successBorder,
  },
  warning: {
    background: colors.warningBackground,
    text: colors.warningText,
    border: colors.warningBorder,
  },
  danger: {
    background: colors.dangerBackground,
    text: colors.dangerText,
    border: colors.dangerBorder,
  },
  info: { background: colors.infoBackground, text: colors.infoText, border: colors.infoBorder },
  wfh: { background: colors.wfhBackground, text: colors.wfhText, border: colors.wfhBorder },
  cancelled: {
    background: colors.cancelledBackground,
    text: colors.textSecondary,
    border: colors.borderDefault,
  },
};

export function Button({
  children,
  variant = 'primary',
  loading,
  onPress,
}: {
  readonly children: string;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  readonly loading?: boolean;
  readonly onPress?: () => void;
}): React.JSX.Element {
  const variantStyle =
    variant === 'primary'
      ? styles.primary
      : variant === 'destructive'
        ? styles.destructive
        : variant === 'secondary'
          ? styles.secondary
          : styles.ghost;
  const textStyle =
    variant === 'primary' || variant === 'destructive'
      ? styles.onButton
      : variant === 'ghost'
        ? styles.ghostText
        : styles.buttonText;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={loading}
      style={[styles.button, variantStyle, loading ? styles.disabled : undefined]}
    >
      {loading ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <Text style={textStyle}>{children}</Text>
      )}
    </Pressable>
  );
}
export function Field({
  label,
  required,
  helper,
  children,
}: {
  readonly label: string;
  readonly required?: boolean;
  readonly helper?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      {children}
      {helper ? <Text style={styles.helper}>{helper}</Text> : null}
    </View>
  );
}
export function Input({
  placeholder,
  multiline = false,
}: {
  readonly placeholder: string;
  readonly multiline?: boolean;
}): React.JSX.Element {
  return (
    <TextInput
      accessibilityLabel={placeholder}
      placeholder={placeholder}
      placeholderTextColor={colors.textTertiary}
      multiline={multiline}
      style={[styles.input, multiline ? styles.textarea : undefined]}
    />
  );
}
export function Toggle({ label }: { readonly label: string }): React.JSX.Element {
  const [checked, setChecked] = useState(false);
  return (
    <View style={styles.toggle}>
      <Text style={styles.label}>{label}</Text>
      <Switch
        value={checked}
        onValueChange={setChecked}
        trackColor={{ false: colors.borderStrong, true: colors.greenPrimary600 }}
        thumbColor={colors.surfaceRaised}
      />
    </View>
  );
}
export function Choice({ label }: { readonly label: string }): React.JSX.Element {
  const [checked, setChecked] = useState(false);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => setChecked(!checked)}
      style={styles.choice}
    >
      <View style={[styles.checkbox, checked ? styles.checkboxChecked : undefined]} />{' '}
      <Text>{label}</Text>
    </Pressable>
  );
}
export function Card({
  title,
  children,
}: {
  readonly title?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      {title ? <Text style={styles.cardTitle}>{title}</Text> : null}
      {children}
    </View>
  );
}
export function Badge({
  tone = 'info',
  children,
}: {
  readonly tone?: Tone;
  readonly children: string;
}): React.JSX.Element {
  const value = toneStyles[tone];
  return (
    <View style={[styles.badge, { backgroundColor: value.background, borderColor: value.border }]}>
      <Text style={{ color: value.text, fontSize: typography.caption, fontWeight: '500' }}>
        {children}
      </Text>
    </View>
  );
}
export function Progress({ value }: { readonly value: number }): React.JSX.Element {
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { flex: value }]} />
      <View style={{ flex: 100 - value }} />
    </View>
  );
}
export function DataTable({
  headers,
  rows,
}: {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): React.JSX.Element {
  return (
    <ScrollView horizontal style={styles.table}>
      <View>
        {[headers, ...rows].map((row, rowIndex) => (
          <View
            style={[styles.tableRow, rowIndex === 0 ? styles.tableHeader : undefined]}
            key={rowIndex}
          >
            {row.map((cell, index) => (
              <Text
                style={[styles.tableCell, rowIndex === 0 ? styles.tableHeaderText : undefined]}
                key={index}
              >
                {cell}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
export function Alert({
  tone = 'info',
  title,
  body,
}: {
  readonly tone?: Exclude<Tone, 'wfh' | 'cancelled'>;
  readonly title: string;
  readonly body: string;
}): React.JSX.Element {
  const value = toneStyles[tone];
  return (
    <View
      accessibilityRole={tone === 'danger' ? 'alert' : 'summary'}
      style={[styles.alert, { backgroundColor: value.background, borderStartColor: value.text }]}
    >
      <Text style={[styles.alertTitle, { color: value.text }]}>{title}</Text>
      <Text>{body}</Text>
    </View>
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
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>○</Text>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.helper}>{description}</Text>
      {action}
    </View>
  );
}
export function Skeleton(): React.JSX.Element {
  return (
    <View accessibilityLabel="Loading" style={styles.skeleton}>
      <View style={styles.skeletonLine} />
      <View style={[styles.skeletonLine, { width: '80%' }]} />
      <View style={[styles.skeletonLine, { width: '60%' }]} />
    </View>
  );
}
export function AppNavigation({ items }: { readonly items: readonly string[] }): React.JSX.Element {
  return (
    <View style={styles.navigation}>
      {items.map((item, index) => (
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: index === 0 }}
          style={[styles.navItem, index === 0 ? styles.navActive : undefined]}
          key={item}
        >
          <Text style={index === 0 ? styles.onButton : styles.navText}>{item}</Text>
        </Pressable>
      ))}
    </View>
  );
}
export function Dialog({
  visible,
  title,
  body,
  close,
  onClose,
}: {
  readonly visible: boolean;
  readonly title: string;
  readonly body: string;
  readonly close: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <NativeModal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View accessibilityViewIsModal style={styles.modal}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Text>{body}</Text>
          <Button onPress={onClose}>{close}</Button>
        </View>
      </View>
    </NativeModal>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: spacing[4],
    borderRadius: radii.md,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  primary: { backgroundColor: colors.greenPrimary600 },
  secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.borderDefault },
  ghost: {},
  destructive: { backgroundColor: colors.dangerText },
  onButton: { color: colors.white, fontWeight: '600' },
  buttonText: { color: colors.textPrimary, fontWeight: '600' },
  ghostText: { color: colors.greenPrimary600, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  field: { gap: spacing[1] },
  label: { color: colors.textPrimary, fontSize: typography.body, fontWeight: '600' },
  required: { color: colors.dangerText },
  helper: { color: colors.textSecondary, fontSize: typography.caption },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.borderDefault,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: spacing[3],
    color: colors.textPrimary,
    fontSize: typography.body,
  },
  textarea: { minHeight: 96, paddingVertical: spacing[2], textAlignVertical: 'top' },
  toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  choice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  checkbox: {
    width: 18,
    height: 18,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.sm,
  },
  checkboxChecked: { backgroundColor: colors.greenPrimary600, borderColor: colors.greenPrimary600 },
  card: {
    gap: spacing[3],
    padding: spacing[4],
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    shadowColor: colors.brown700,
    shadowOpacity: 0.07,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  cardTitle: { color: colors.textPrimary, fontSize: typography.h3, fontWeight: '600' },
  badge: {
    minHeight: 24,
    alignSelf: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
    borderRadius: radii.sm,
    borderWidth: 1,
  },
  progressTrack: {
    height: 8,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: radii.full,
    backgroundColor: colors.sage200,
  },
  progressFill: { backgroundColor: colors.greenPrimary600 },
  table: { borderWidth: 1, borderColor: colors.borderSubtle, borderRadius: radii.lg },
  tableRow: {
    minHeight: 52,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderColor: colors.borderSubtle,
  },
  tableHeader: { minHeight: 44, backgroundColor: colors.page },
  tableCell: { width: 150, padding: spacing[3], color: colors.textPrimary },
  tableHeaderText: { color: colors.textSecondary, fontSize: typography.caption, fontWeight: '600' },
  alert: { gap: spacing[1], padding: spacing[4], borderStartWidth: 3, borderRadius: radii.md },
  alertTitle: { fontWeight: '700' },
  empty: { alignItems: 'center', gap: spacing[2], padding: spacing[8] },
  emptyIcon: { color: colors.sage300, fontSize: 96, lineHeight: 96 },
  skeleton: { gap: spacing[2] },
  skeletonLine: { height: 12, borderRadius: radii.sm, backgroundColor: colors.sage100 },
  navigation: {
    flexDirection: 'row',
    gap: spacing[2],
    flexWrap: 'wrap',
    padding: spacing[2],
    backgroundColor: colors.greenDeep800,
    borderRadius: radii.lg,
  },
  navItem: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    borderRadius: radii.md,
  },
  navActive: { backgroundColor: colors.greenPrimary600 },
  navText: { color: colors.textOnDarkMuted },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(27,46,18,.45)' },
  modal: {
    gap: spacing[5],
    padding: spacing[6],
    borderTopStartRadius: radii.xl,
    borderTopEndRadius: radii.xl,
    backgroundColor: colors.surfaceRaised,
  },
  modalTitle: { color: colors.textPrimary, fontSize: typography.h2, fontWeight: '600' },
});
