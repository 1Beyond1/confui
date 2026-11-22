import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";

export function UnsavedConfigModal({
  kind,
  changeCount,
  onCancel,
  onDiscard,
  onSaveAndContinue,
}: {
  kind?: string;
  changeCount: number;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndContinue: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={t("unsaved.configTitle")}
      description={t("unsaved.configDesc")}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>{t("unsaved.keepEditing")}</Button>
          <Button variant="danger" onClick={onDiscard}>{t("unsaved.discard")}</Button>
          <Button variant="primary" icon="save" onClick={onSaveAndContinue}>{t("unsaved.saveAndContinue")}</Button>
        </>
      )}
    >
      <div class="unsaved-summary">
        <span><Icon name="file"/></span>
        <div>
          <strong>{kind}</strong>
          <p>{t("unsaved.configSummary", { count: changeCount })}</p>
        </div>
      </div>
    </Modal>
  );
}

export function UnsavedSettingsModal({
  onCancel,
  onDiscard,
}: {
  onCancel: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      title={t("unsaved.settingsTitle")}
      description={t("unsaved.settingsDesc")}
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>{t("unsaved.backToSettings")}</Button>
          <Button variant="danger" onClick={onDiscard}>{t("unsaved.discardAndContinue")}</Button>
        </>
      )}
    >
      <div class="unsaved-summary">
        <span><Icon name="settings"/></span>
        <div>
          <strong>{t("unsaved.settingsName")}</strong>
          <p>{t("unsaved.settingsSummary")}</p>
        </div>
      </div>
    </Modal>
  );
}
