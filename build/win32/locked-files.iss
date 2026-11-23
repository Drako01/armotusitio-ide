// Files held open by another program during a background update.
//
// Some antivirus services (seen with McAfee's mc-fw-host) keep executables they watched open until the next reboot.
// They open them sharing delete access, so Windows still lets the file be renamed, but inno_updater opens every
// installed file exclusively before deleting it and gives up with os error 32 when one is held. Moving such a file
// into tools\stale, a folder inno_updater skips, frees its name so the swap can finish; a later update deletes it.
//
// Included from the [Code] section of code.iss.

const
  LockedFilesDeleteAccess = $10000;
  LockedFilesOpenExisting = 3;
  LockedFilesAttributeNormal = $80;
  LockedFilesInvalidHandle = -1;

var
  LockedFilesMoved: TStringList;
  LockedFilesStaleDir: String;

// NativeInt keeps handles and pointers at their real size in both 32-bit and 64-bit Setup.
function LockedFilesCreateFile(lpFileName: String; dwDesiredAccess, dwShareMode: Cardinal; lpSecurityAttributes: NativeInt; dwCreationDisposition, dwFlagsAndAttributes: Cardinal; hTemplateFile: NativeInt): NativeInt;
  external 'CreateFileW@kernel32.dll stdcall';

function LockedFilesCloseHandle(hObject: NativeInt): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

// The folder that collects moved files; inno_updater never touches {app}\tools.
function LockedFilesStaleRoot(const Root: String): String;
begin
  Result := AddBackslash(Root) + 'tools\stale';
end;

// Opens the file the way inno_updater does before deleting it: delete access, no sharing.
function IsFileHeldOpen(const Path: String): Boolean;
var
  Handle: NativeInt;
begin
  Handle := LockedFilesCreateFile(Path, LockedFilesDeleteAccess, 0, 0, LockedFilesOpenExisting, LockedFilesAttributeNormal, 0);
  Result := Handle = LockedFilesInvalidHandle;
  if not Result then
    LockedFilesCloseHandle(Handle);
end;

// Moves Root\RelativePath into the stale folder when another program holds it, and remembers it for a rollback.
procedure MoveFileAsideIfHeld(const Root, RelativePath: String);
var
  Source, Target: String;
begin
  Source := AddBackslash(Root) + RelativePath;
  if not FileExists(Source) or not IsFileHeldOpen(Source) then
    exit;
  if LockedFilesStaleDir = '' then begin
    // One folder per update run; a suffix keeps runs within the same second apart.
    LockedFilesStaleDir := AddBackslash(LockedFilesStaleRoot(Root)) + GetDateTimeString('yyyymmddhhnnss', #0, #0);
    while DirExists(LockedFilesStaleDir) do
      LockedFilesStaleDir := LockedFilesStaleDir + '-';
  end;
  Target := AddBackslash(LockedFilesStaleDir) + RelativePath;
  ForceDirectories(ExtractFileDir(Target));
  if RenameFile(Source, Target) then begin
    if LockedFilesMoved = nil then
      LockedFilesMoved := TStringList.Create;
    LockedFilesMoved.Add(RelativePath);
    Log('Moved a file held by another program out of the way: ' + Source + ' -> ' + Target);
  end else
    Log('A file is held by another program and cannot be moved: ' + Source);
end;

// An antivirus may hold the previous inno_updater, which a background update replaces while it stages.
// Used as the BeforeInstall of the tools files.
procedure MoveToolAsideIfHeld();
begin
  MoveFileAsideIfHeld(ExpandConstant('{app}'), 'tools\' + ExtractFileName(ExpandConstant(CurrentFileName)));
end;

// The top-level entries inno_updater leaves in place: the staged update, its own tools, the uninstaller and the
// sparse package and bootstrap folders. Mirrors delete_existing_version in inno_updater 0.23.0.
function IsSkippedByUpdater(const Name: String): Boolean;
begin
  Result := (Name = '_') or (CompareText(Name, 'tools') = 0) or (CompareText(Copy(Name, 1, 5), 'unins') = 0)
    or (CompareText(Name, 'appx') = 0) or (CompareText(Name, 'bootstrap') = 0);
end;

// Moves every file under Root\RelativeDir that another program holds open out of inno_updater's way.
procedure MoveHeldFilesAsideIn(const Root, RelativeDir: String);
var
  Find: TFindRec;
  RelativePath: String;
begin
  if not FindFirst(AddBackslash(AddBackslash(Root) + RelativeDir) + '*', Find) then
    exit;
  try
    repeat
      if (Find.Name = '.') or (Find.Name = '..') or ((RelativeDir = '') and IsSkippedByUpdater(Find.Name)) then
        continue;
      if RelativeDir = '' then
        RelativePath := Find.Name
      else
        RelativePath := AddBackslash(RelativeDir) + Find.Name;
      if Find.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
        MoveHeldFilesAsideIn(Root, RelativePath)
      else
        MoveFileAsideIfHeld(Root, RelativePath);
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

// Puts the moved files back where nothing replaced them, so a failed update leaves the previous version whole.
procedure RestoreMovedFiles(const Root: String);
var
  I: Integer;
  Target: String;
begin
  if LockedFilesMoved = nil then
    exit;
  for I := 0 to LockedFilesMoved.Count - 1 do begin
    Target := AddBackslash(Root) + LockedFilesMoved[I];
    if not FileExists(Target) and RenameFile(AddBackslash(LockedFilesStaleDir) + LockedFilesMoved[I], Target) then
      Log('Restored a moved file: ' + Target);
  end;
  LockedFilesMoved.Clear;
end;

// Deletes what earlier updates moved aside; a file still held stays until a later update.
procedure DeleteStaleFiles(const Root: String);
begin
  if DirExists(LockedFilesStaleRoot(Root)) and not DelTree(LockedFilesStaleRoot(Root), True, True, True) then
    Log('Some files moved aside by an earlier update are still held and stay for a later update');
end;

// Runs inno_updater after moving held files out of its way. When it fails, the moved files go back, so the previous
// version still starts.
function RunUpdaterAroundHeldFiles(const Updater, ExePath, Params: String; var ResultCode: Integer): Boolean;
var
  Root: String;
  Placeholder: Boolean;
begin
  Root := ExtractFileDir(ExePath);
  DeleteStaleFiles(Root);
  MoveHeldFilesAsideIn(Root, '');
  // inno_updater refuses to start without the executable; an empty file that it deletes like the rest stands in for it.
  Placeholder := False;
  if not FileExists(ExePath) then
    Placeholder := SaveStringToFile(ExePath, '', False);
  Result := Exec(Updater, Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not Result then begin
    if Placeholder then
      DeleteFile(ExePath);
    RestoreMovedFiles(Root);
  end;
end;
