; Built by build/build.bat installer. All payload paths are provided by the build.
#ifndef AppVersion
  #error AppVersion is required
#endif

[Setup]
AppId={{5F9DB052-9F61-4EB3-97F2-7625BBF49C23}
AppName=UBOVM IDE
AppVersion={#AppVersion}
AppVerName=UBOVM IDE {#AppVersion}
AppPublisher=UBOVM
DefaultDirName={localappdata}\Programs\UBOVM
DefaultGroupName=UBOVM
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=UBOVM-Setup-{#AppVersion}-x64
SetupIconFile={#AppIcon}
UninstallDisplayIcon={app}\UBOVM.exe
VersionInfoVersion={#AppVersion}
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=yes
CloseApplicationsFilter=UBOVM.exe
RestartApplications=no
Uninstallable=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "simplifiedChinese"; MessagesFile: "{#ChineseMessages}"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; Only replace app-owned code. ~/.ubovm user data is outside the install tree.
Type: filesandordirs; Name: "{app}\resources\app\extensions\ubovm-core"
Type: filesandordirs; Name: "{app}\resources\app\ubovm"

[Icons]
Name: "{group}\UBOVM IDE"; Filename: "{app}\UBOVM.exe"; AppUserModelID: "UBOVM.IDE"
Name: "{autodesktop}\UBOVM IDE"; Filename: "{app}\UBOVM.exe"; Tasks: desktopicon; AppUserModelID: "UBOVM.IDE"

[Run]
Filename: "{app}\UBOVM.exe"; Description: "{cm:LaunchProgram,UBOVM IDE}"; Flags: nowait postinstall skipifsilent
