import { Call } from "@wailsio/runtime";

function invoke(method, ...args) {
  const fixture = window.go?.app?.App;
  return fixture ? fixture[method](...args) : Call.ByName('gxShell/internal/app.App.' + method, ...args);
}

export function TestProfileConnection(profile) { return invoke("TestProfileConnection", profile); }

export function ListNamedSecrets() { return invoke("ListNamedSecrets"); }
export function SaveNamedSecret(alias, value, replace) { return invoke("SaveNamedSecret", alias, value, replace); }
export function DeleteNamedSecret(alias) { return invoke("DeleteNamedSecret", alias); }

export function StartAiInspectionFollowup(id, question, focusEvidenceID) { return invoke("StartAiInspectionFollowup", id, question, focusEvidenceID); }
export function GetAiHostDossier(profileID) { return invoke("GetAiHostDossier", profileID); }
export function SaveAiHostDossier(profileID, input) { return invoke("SaveAiHostDossier", profileID, input); }
export function DeleteAiHostDossier(profileID, revision) { return invoke("DeleteAiHostDossier", profileID, revision); }
export function FeedbackAiInspection(id, outcome, note) { return invoke("FeedbackAiInspection", id, outcome, note); }
export function ListAiInspectionEvaluationCases() { return invoke("ListAiInspectionEvaluationCases"); }
export function ListAiInspectionEvaluations() { return invoke("ListAiInspectionEvaluations"); }
export function GetAiInspectionStats() { return invoke("GetAiInspectionStats"); }
export function SaveAiInspectionCase(runID, title, expected) { return invoke("SaveAiInspectionCase", runID, title, expected); }
export function DeleteAiInspectionCase(id) { return invoke("DeleteAiInspectionCase", id); }
export function StartAiInspectionEvaluation(caseIDs) { return invoke("StartAiInspectionEvaluation", caseIDs); }
export function CancelAiInspectionEvaluation(id) { return invoke("CancelAiInspectionEvaluation", id); }

export function StartAiInspection(sessionID) {
  return invoke("StartAiInspection", sessionID);
}
export function StartAiServiceDiagnosis(sessionID, service, port) {
  return invoke("StartAiServiceDiagnosis", sessionID, service, port);
}
export function StartAiDiskDiagnosis(sessionID) { return invoke("StartAiDiskDiagnosis", sessionID); }
export function ReviewAiInspectionUnknown(id, unknownID, outcome, note) { return invoke("ReviewAiInspectionUnknown", id, unknownID, outcome, note); }
export function CompareAiInspections(currentID, baselineID) { return invoke("CompareAiInspections", currentID, baselineID); }
export function PrepareAiInspectionPlan(id, kind) { return invoke("PrepareAiInspectionPlan", id, kind); }
export function ExecuteAiInspectionPlan(id, planID) { return invoke("ExecuteAiInspectionPlan", id, planID); }
export function DismissAiInspectionPlan(id, planID) { return invoke("DismissAiInspectionPlan", id, planID); }
export function ExportAiInspection(id) {
  return invoke("ExportAiInspection", id);
}
export function ListAiInspections() {
  return invoke("ListAiInspections");
}
export function GetAiInspection(id) {
  return invoke("GetAiInspection", id);
}
export function CancelAiInspection(id) {
  return invoke("CancelAiInspection", id);
}

export function AddFirewallRule(arg1, arg2, arg3, arg4, arg5, arg6) {
  return invoke("AddFirewallRule", arg1, arg2, arg3, arg4, arg5, arg6);
}

export function AddTunnelRule(arg1, arg2) {
  return invoke("AddTunnelRule", arg1, arg2);
}

export function AiChat(arg1) {
  return invoke("AiChat", arg1);
}

export function AiContinueChat(arg1) {
  return invoke("AiContinueChat", arg1);
}

export function AiExecuteTool(arg1, arg2) {
  return invoke("AiExecuteTool", arg1, arg2);
}

export function AiExecuteTools(arg1, arg2) {
  return invoke("AiExecuteTools", arg1, arg2);
}

export function AnswerKeyboardInteractive(arg1, arg2, arg3) {
  return invoke("AnswerKeyboardInteractive", arg1, arg2, arg3);
}

export function CancelAiChat(arg1, arg2) {
  return invoke("CancelAiChat", arg1, arg2);
}

export function CancelTransfer(arg1) {
  return invoke("CancelTransfer", arg1);
}

export function PauseTransfer(arg1) {
  return invoke("PauseTransfer", arg1);
}

export function ResumeTransfer(arg1) {
  return invoke("ResumeTransfer", arg1);
}

export function CheckForUpdate() {
  return invoke("CheckForUpdate");
}

export function Connect(arg1, arg2, arg3) {
  return invoke("Connect", arg1, arg2, arg3);
}

export function ConnectLocal(arg1, arg2) {
  return invoke("ConnectLocal", arg1, arg2);
}

export function ConnectQuick(arg1, arg2, arg3) {
  return invoke("ConnectQuick", arg1, arg2, arg3);
}

export function ConnectWithSecrets(arg1, arg2, arg3, arg4, arg5) {
  return invoke("ConnectWithSecrets", arg1, arg2, arg3, arg4, arg5);
}

export function ConnectTerminal(profileId, instanceId, password, passphrase, cols, rows) {
  return invoke("ConnectTerminal", profileId, instanceId, password, passphrase, cols, rows);
}

export function ContainerLogs(arg1, arg2, arg3) {
  return invoke("ContainerLogs", arg1, arg2, arg3);
}

export function CreateCommand(arg1) {
  return invoke("CreateCommand", arg1);
}

export function CreateProfile(arg1) {
  return invoke("CreateProfile", arg1);
}

export function CreateRemoteDir(arg1, arg2) {
  return invoke("CreateRemoteDir", arg1, arg2);
}

export function DeleteCommand(arg1) {
  return invoke("DeleteCommand", arg1);
}

export function DeleteCronJob(arg1, arg2) {
  return invoke("DeleteCronJob", arg1, arg2);
}

export function DeleteFirewallRule(arg1, arg2, arg3, arg4) {
  return invoke("DeleteFirewallRule", arg1, arg2, arg3, arg4);
}

export function DeleteProfile(arg1) {
  return invoke("DeleteProfile", arg1);
}

export function DeleteRecording(arg1) {
  return invoke("DeleteRecording", arg1);
}

export function DeleteRemoteFile(arg1, arg2) {
  return invoke("DeleteRemoteFile", arg1, arg2);
}

export function DeleteWebsite(arg1, arg2, arg3, arg4) {
  return invoke("DeleteWebsite", arg1, arg2, arg3, arg4);
}

export function Disconnect(arg1) {
  return invoke("Disconnect", arg1);
}

export function DownloadFile(arg1, arg2, arg3) {
  return invoke("DownloadFile", arg1, arg2, arg3);
}

export function DownloadFileWithPolicy(arg1, arg2, arg3, arg4) {
  return invoke("DownloadFileWithPolicy", arg1, arg2, arg3, arg4);
}

export function DownloadFolder(arg1, arg2, arg3) {
  return invoke("DownloadFolder", arg1, arg2, arg3);
}

export function DuplicateProfile(arg1) {
  return invoke("DuplicateProfile", arg1);
}

export function ExportHistory() {
  return invoke("ExportHistory");
}

export function ExportProfiles(arg1) {
  return invoke("ExportProfiles", arg1);
}

export function ExportBackup(passphrase, workspaces, includeSecrets, includePrivateKeys) {
  return invoke("ExportBackup", passphrase, workspaces, includeSecrets, includePrivateKeys);
}

export function PreviewBackup(passphrase, workspaces, policy, restoreSettings) {
  return invoke("PreviewBackup", passphrase, workspaces, policy, restoreSettings);
}

export function ApplyBackup(token, previousWorkspaces) {
  return invoke("ApplyBackup", token, previousWorkspaces);
}

export function DiscardBackupPreview(token) {
  return invoke("DiscardBackupPreview", token);
}

export function GetAiConfig() {
  return invoke("GetAiConfig");
}

export function GetAiUsage() {
  return invoke("GetAiUsage");
}

export function GetAppInfo() {
  return invoke("GetAppInfo");
}

export function GetFirewallStatus(arg1) {
  return invoke("GetFirewallStatus", arg1);
}

export function GetLatestMetrics(arg1) {
  return invoke("GetLatestMetrics", arg1);
}

export function GetNetworkPath(arg1) {
  return invoke("GetNetworkPath", arg1);
}

export function GetProfile(arg1) {
  return invoke("GetProfile", arg1);
}

export function GetSettings() {
  return invoke("GetSettings");
}

export function GetStartupFile() {
  return invoke("GetStartupFile");
}

export function GetVersion() {
  return invoke("GetVersion");
}

export function GetWebsiteConfig(arg1, arg2, arg3, arg4) {
  return invoke("GetWebsiteConfig", arg1, arg2, arg3, arg4);
}

export function GetWebsiteStatus(arg1) {
  return invoke("GetWebsiteStatus", arg1);
}

export function ImportOpenSSHConfig() {
  return invoke("ImportOpenSSHConfig");
}

export function ImportProfiles() {
  return invoke("ImportProfiles");
}

export function IsMarkdownContextMenuRegistered() {
  return invoke("IsMarkdownContextMenuRegistered");
}

export function IsRecording(arg1) {
  return invoke("IsRecording", arg1);
}

export function IsTextContextMenuRegistered() {
  return invoke("IsTextContextMenuRegistered");
}

export function ListAiModels(arg1, arg2, arg3) {
  return invoke("ListAiModels", arg1, arg2, arg3);
}

export function ListCommands() {
  return invoke("ListCommands");
}

export function ListContainers(arg1, arg2) {
  return invoke("ListContainers", arg1, arg2);
}

export function ListCronJobs(arg1) {
  return invoke("ListCronJobs", arg1);
}

export function ListKnownHosts() {
  return invoke("ListKnownHosts");
}

export function ListLocalDir(arg1) {
  return invoke("ListLocalDir", arg1);
}

export function ListLogFiles() {
  return invoke("ListLogFiles");
}

export function ListMarkdownFilesInDir(arg1) {
  return invoke("ListMarkdownFilesInDir", arg1);
}

export function ListProfiles() {
  return invoke("ListProfiles");
}

export function ListRecordings() {
  return invoke("ListRecordings");
}

export function ListRemoteDir(arg1, arg2) {
  return invoke("ListRemoteDir", arg1, arg2);
}

export function ListRemoteMarkdownFilesInDir(arg1, arg2) {
  return invoke("ListRemoteMarkdownFilesInDir", arg1, arg2);
}

export function ListRemoteTextFilesInDir(arg1, arg2) {
  return invoke("ListRemoteTextFilesInDir", arg1, arg2);
}

export function ListServices(arg1) {
  return invoke("ListServices", arg1);
}

export function ListSessions() {
  return invoke("ListSessions");
}

export function ListTextFilesInDir(arg1) {
  return invoke("ListTextFilesInDir", arg1);
}

export function ListTunnelStatus(arg1) {
  return invoke("ListTunnelStatus", arg1);
}

export function LocalHomeDir() {
  return invoke("LocalHomeDir");
}

export function LogCommand(arg1, arg2) {
  return invoke("LogCommand", arg1, arg2);
}

export function OpenDataDir() {
  return invoke("OpenDataDir");
}

export function OpenRecentMarkdownFile(arg1) {
  return invoke("OpenRecentMarkdownFile", arg1);
}

export function OpenRecentTextFile(arg1) {
  return invoke("OpenRecentTextFile", arg1);
}

export function OpenRecordingsDir() {
  return invoke("OpenRecordingsDir");
}

export function PingHost(arg1, arg2) {
  return invoke("PingHost", arg1, arg2);
}

export function ReadLocalFile(arg1) {
  return invoke("ReadLocalFile", arg1);
}

export function ReadLocalMarkdownResourceDataURL(arg1, arg2) {
  return invoke("ReadLocalMarkdownResourceDataURL", arg1, arg2);
}

export function ReadLocalPDFBase64(arg1) {
  return invoke("ReadLocalPDFBase64", arg1);
}

export function ReadLogFile(arg1) {
  return invoke("ReadLogFile", arg1);
}

export function RegisterApprovalPanel() {
  return invoke("RegisterApprovalPanel");
}

export function ResolveCliApproval(arg1, arg2) {
  return invoke("ResolveCliApproval", arg1, arg2);
}

export function ReadLogs(arg1) {
  return invoke("ReadLogs", arg1);
}

export function ReadRecording(arg1) {
  return invoke("ReadRecording", arg1);
}

export function ReadRemoteMarkdownResourceDataURL(arg1, arg2, arg3) {
  return invoke("ReadRemoteMarkdownResourceDataURL", arg1, arg2, arg3);
}

export function ReadRemoteTextFile(arg1, arg2) {
  return invoke("ReadRemoteTextFile", arg1, arg2);
}

export function Reconnect(arg1) {
  return invoke("Reconnect", arg1);
}

export function ReconnectWithSecrets(arg1, arg2, arg3) {
  return invoke("ReconnectWithSecrets", arg1, arg2, arg3);
}

export function RegisterMarkdownContextMenu() {
  return invoke("RegisterMarkdownContextMenu");
}

export function RegisterTextContextMenu() {
  return invoke("RegisterTextContextMenu");
}

export function RemoveContainer(arg1, arg2, arg3) {
  return invoke("RemoveContainer", arg1, arg2, arg3);
}

export function RemoveKnownHost(arg1, arg2) {
  return invoke("RemoveKnownHost", arg1, arg2);
}

export function RemoveTunnelRule(arg1, arg2) {
  return invoke("RemoveTunnelRule", arg1, arg2);
}

export function RenameRemoteFile(arg1, arg2, arg3) {
  return invoke("RenameRemoteFile", arg1, arg2, arg3);
}

export function RequestCloseWindow() {
  return invoke("RequestCloseWindow");
}

export function ResetAiUsage() {
  return invoke("ResetAiUsage");
}

export function ResizeTerminal(arg1, arg2, arg3) {
  return invoke("ResizeTerminal", arg1, arg2, arg3);
}

export function ResolveLocalMarkdownLink(arg1, arg2) {
  return invoke("ResolveLocalMarkdownLink", arg1, arg2);
}

export function ResolveRemoteMarkdownLink(arg1, arg2) {
  return invoke("ResolveRemoteMarkdownLink", arg1, arg2);
}

export function RestartContainer(arg1, arg2) {
  return invoke("RestartContainer", arg1, arg2);
}

export function RestartTunnels(arg1) {
  return invoke("RestartTunnels", arg1);
}

export function RestoreTextFiles(arg1) {
  return invoke("RestoreTextFiles", arg1);
}

export function RevokeCliTrust(arg1) {
  return invoke("RevokeCliTrust", arg1);
}

export function RunCronJob(arg1, arg2) {
  return invoke("RunCronJob", arg1, arg2);
}

export function SaveAiConfig(arg1, arg2, arg3, arg4) {
  return invoke("SaveAiConfig", arg1, arg2, arg3, arg4);
}

export function SaveCronJob(arg1, arg2, arg3, arg4, arg5) {
  return invoke("SaveCronJob", arg1, arg2, arg3, arg4, arg5);
}

export function SaveWebsiteConfig(arg1, arg2, arg3, arg4, arg5) {
  return invoke("SaveWebsiteConfig", arg1, arg2, arg3, arg4, arg5);
}

export function SelectDownloadPath(arg1) {
  return invoke("SelectDownloadPath", arg1);
}

export function SelectMarkdownFile() {
  return invoke("SelectMarkdownFile");
}

export function SelectPrivateKey() {
  return invoke("SelectPrivateKey");
}

export function SelectTextFile() {
  return invoke("SelectTextFile");
}

export function SelectUploadFile() {
  return invoke("SelectUploadFile");
}

export function SendCommandToAll(arg1) {
  return invoke("SendCommandToAll", arg1);
}

export function SendCommandToTerminal(arg1, arg2) {
  return invoke("SendCommandToTerminal", arg1, arg2);
}

export function ServiceAction(arg1, arg2, arg3, arg4) {
  return invoke("ServiceAction", arg1, arg2, arg3, arg4);
}

export function ServiceLogs(arg1, arg2, arg3) {
  return invoke("ServiceLogs", arg1, arg2, arg3);
}

export function SetCronJobEnabled(arg1, arg2, arg3) {
  return invoke("SetCronJobEnabled", arg1, arg2, arg3);
}

export function SetFirewallEnabled(arg1, arg2, arg3) {
  return invoke("SetFirewallEnabled", arg1, arg2, arg3);
}

export function SetWebsiteEnabled(arg1, arg2, arg3, arg4, arg5) {
  return invoke("SetWebsiteEnabled", arg1, arg2, arg3, arg4, arg5);
}

export function SkipUpdateVersion(arg1) {
  return invoke("SkipUpdateVersion", arg1);
}

export function StartContainer(arg1, arg2) {
  return invoke("StartContainer", arg1, arg2);
}

export function StartMonitor(arg1) {
  return invoke("StartMonitor", arg1);
}

export function StartNetworkPing(arg1, arg2) {
  return invoke("StartNetworkPing", arg1, arg2);
}

export function StartRecording(arg1, arg2) {
  return invoke("StartRecording", arg1, arg2);
}

export function StopContainer(arg1, arg2) {
  return invoke("StopContainer", arg1, arg2);
}

export function StopContainerLogs(arg1) {
  return invoke("StopContainerLogs", arg1);
}

export function StopMonitor(arg1) {
  return invoke("StopMonitor", arg1);
}

export function StopNetworkPing(arg1) {
  return invoke("StopNetworkPing", arg1);
}

export function StopRecording(arg1) {
  return invoke("StopRecording", arg1);
}

export function StopServiceLogs(arg1) {
  return invoke("StopServiceLogs", arg1);
}

export function StreamContainerLogs(arg1, arg2, arg3, arg4) {
  return invoke("StreamContainerLogs", arg1, arg2, arg3, arg4);
}

export function StreamServiceLogs(arg1, arg2, arg3, arg4) {
  return invoke("StreamServiceLogs", arg1, arg2, arg3, arg4);
}

export function TestWebsiteConfig(arg1, arg2) {
  return invoke("TestWebsiteConfig", arg1, arg2);
}

export function TraceRoute(arg1) {
  return invoke("TraceRoute", arg1);
}

export function UnregisterMarkdownContextMenu() {
  return invoke("UnregisterMarkdownContextMenu");
}

export function UnregisterTextContextMenu() {
  return invoke("UnregisterTextContextMenu");
}

export function UpdateCommand(arg1) {
  return invoke("UpdateCommand", arg1);
}

export function UpdateProfile(arg1) {
  return invoke("UpdateProfile", arg1);
}

export function UpdateSettings(arg1) {
  return invoke("UpdateSettings", arg1);
}

export function UploadFile(arg1, arg2, arg3) {
  return invoke("UploadFile", arg1, arg2, arg3);
}

export function UploadFileWithPolicy(arg1, arg2, arg3, arg4) {
  return invoke("UploadFileWithPolicy", arg1, arg2, arg3, arg4);
}

export function WriteLocalFile(arg1, arg2, arg3) {
  return invoke("WriteLocalFile", arg1, arg2, arg3);
}

export function WriteRemoteTextFile(arg1, arg2, arg3, arg4) {
  return invoke("WriteRemoteTextFile", arg1, arg2, arg3, arg4);
}

export function WriteToTerminal(arg1, arg2) {
  return invoke("WriteToTerminal", arg1, arg2);
}

// Window chrome for the frameless top bar (internal/app/app_window.go).

export function CloseWindow() {
  return invoke("CloseWindow");
}

export function IsWindowMaximised() {
  return invoke("IsWindowMaximised");
}

export function MinimiseWindow() {
  return invoke("MinimiseWindow");
}

export function SetWindowBackgroundColour(arg1, arg2, arg3) {
  return invoke("SetWindowBackgroundColour", arg1, arg2, arg3);
}

export function ToggleMaximiseWindow() {
  return invoke("ToggleMaximiseWindow");
}
export function ListSessionLogFiles() {
  return invoke("ListSessionLogFiles");
}

export function ReadSessionLogFile(name) {
  return invoke("ReadSessionLogFile", name);
}
export function UpdateProfilesBatch(ids, patch) {
  return invoke("UpdateProfilesBatch", ids, patch);
}

export function StartAiInspectionBatch(sessionIDs, concurrency) {
  return invoke("StartAiInspectionBatch", sessionIDs, concurrency);
}
export function ListAiInspectionBatches() {
  return invoke("ListAiInspectionBatches");
}
export function GetAiInspectionBatch(id) {
  return invoke("GetAiInspectionBatch", id);
}
export function CancelAiInspectionBatch(id) {
  return invoke("CancelAiInspectionBatch", id);
}
export function ExportAiInspectionBatch(id) {
  return invoke("ExportAiInspectionBatch", id);
}

export function OpenTerminalWindow(id, title) { return invoke("OpenTerminalWindow", id, title); }

export function CloseTerminalWindow(id) { return invoke("CloseTerminalWindow", id); }

export function DockTerminalWindow() { return invoke("DockTerminalWindow"); }

export function OpenSessionPanel(kind, id, title) { return invoke("OpenSessionPanel", kind, id, title); }
export function OpenPanelDocument(path) { return invoke("OpenPanelDocument", path); }
export function OpenConnectionWindow(kind, id, title) { return invoke("OpenConnectionWindow", kind, id, title); }
export function RegisterConnectionWindow() { return invoke("RegisterConnectionWindow"); }
export function CloseConnectionWindow() { return invoke("CloseConnectionWindow"); }
export function SaveConnectionProfile(profile) { return invoke("SaveConnectionProfile", profile); }
export function SubmitQuickConnection(profile) { return invoke("SubmitQuickConnection", profile); }
export function TakeQuickConnection(id) { return invoke("TakeQuickConnection", id); }
export function FinishQuickConnection(id, message) { return invoke("FinishQuickConnection", id, message); }

export function GetWindowApproval() { return invoke("GetWindowApproval"); }
export function OpenRemoteDocumentWindow(id, path) { return invoke("OpenRemoteDocumentWindow", id, path); }
export function GetTransferSnapshot() { return invoke("GetTransferSnapshot"); }
export function ClearTransferHistory(sessionID) { return invoke("ClearTransferHistory", sessionID); }
