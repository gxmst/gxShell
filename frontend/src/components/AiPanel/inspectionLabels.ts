import { t } from "../../i18n";

const labels = {
  system: "inspectionSystem", load: "inspectionLoad", disk: "inspectionDisk", memory: "inspectionMemory",
  services: "inspectionServices", ports: "inspectionPorts", containers: "inspectionContainers",
  service: "inspectionServiceDetails", connectivity: "inspectionConnectivity",
  inodes: "inspectionInodes", disk_usage: "inspectionDirectoryUsage", journal: "inspectionJournalUsage", container_storage: "inspectionContainerStorage",
} as const;
export const inspectionCheckLabel = (locale: string, check: string) =>
  check in labels ? t(locale, labels[check as keyof typeof labels]) : check;
