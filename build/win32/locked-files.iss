// Installed files that inno_updater 0.23.0 cannot delete.
//
// Before swapping in a background update, inno_updater opens every installed file with delete access and no sharing,
// through the plain Win32 path, then deletes it. Three kinds of files make that fail and leave the update stuck:
//  - files another program holds open: some antivirus services (seen with McAfee's mc-fw-host) keep executables they
//    watched open until reboot; they share delete access, so Windows still lets the file be renamed;
//  - files whose path reaches the Win32 path limit: inno_updater is not long path aware (os error 3), and the editor
//    and its extensions write files into the install folder while they run, some with very long paths;
//  - read-only files, which cannot be marked for deletion.
// Moving such files into tools\stale, a folder inno_updater skips, lets the swap finish; a later update deletes them.
// The stale files get short numbered names, so the folder never holds long paths itself.
//
// Included from the [Code] section of code.iss.

const
  LockedFilesDeleteAccess = $10000;
  LockedFilesOpenExisting = 3;
  LockedFilesAttributeNormal = $80;
  LockedFilesAttributeReadOnly = $1;
  LockedFilesAttributeDirectory = $10;
  LockedFilesAttributeReparsePoint = $400;
  LockedFilesInvalidHandle = -1;
  LockedFilesInvalidAttributes = $FFFFFFFF;
  // MAX_PATH less the 12 characters Win32 reserves for a file name in a directory path. Moving a file that would still
  // fit costs nothing, since inno_updater deletes it anyway.
  LockedFilesMaxPath = 248;

var
  LockedFilesMoved: TStringList;
  LockedFilesAttributes: TStringList;
  LockedFilesStaleDir: String;

// NativeInt keeps handles and pointers at their real size in both 32-bit and 64-bit Setup.
function LockedFilesCreateFile(lpFileName: String; dwDesiredAccess, dwShareMode: Cardinal; lpSecurityAttributes: NativeInt; dwCreationDisposition, dwFlagsAndAttributes: Cardinal; hTemplateFile: NativeInt): NativeInt;
  external 'CreateFileW@kernel32.dll stdcall';

function LockedFilesCloseHandle(hObject: NativeInt): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function LockedFilesMoveFile(lpExistingFileName, lpNewFileName: String): Boolean;
  external 'MoveFileW@kernel32.dll stdcall';

function LockedFilesGetAttributes(lpFileName: String): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function LockedFilesSetAttributes(lpFileName: String; dwFileAttributes: Cardinal): Boolean;
  external 'SetFileAttributesW@kernel32.dll stdcall';

// The \\?\ form reaches paths past the Win32 limit whatever the system's long path setting.
function ExtendedPath(const Path: String): String;
begin
  if Copy(Path, 1, 4) = '\\?\' then
    Result := Path
  else if Copy(Path, 1, 2) = '\\' then
    Result := '\\?\UNC\' + Copy(Path, 3, Length(Path) - 2)
  else
    Result := '\\?\' + Path;
end;

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
  Handle := LockedFilesCreateFile(ExtendedPath(Path), LockedFilesDeleteAccess, 0, 0, LockedFilesOpenExisting, LockedFilesAttributeNormal, 0);
  Result := Handle = LockedFilesInvalidHandle;
  if not Result then
    LockedFilesCloseHandle(Handle);
end;

// Whether inno_updater would fail on this file: a path at the Win32 limit, read-only, or held by another program.
function UpdaterCannotDelete(const Path: String; Attributes: Cardinal): Boolean;
begin
  Result := (Length(Path) >= LockedFilesMaxPath) or (Attributes and LockedFilesAttributeReadOnly <> 0) or IsFileHeldOpen(Path);
end;

// Moves Root\RelativePath into the stale folder and remembers it, with its attributes, for a rollback.
procedure MoveFileAside(const Root, RelativePath: String; Attributes: Cardinal);
var
  Source, Target: String;
begin
  Source := AddBackslash(Root) + RelativePath;
  if LockedFilesMoved = nil then begin
    LockedFilesMoved := TStringList.Create;
    LockedFilesAttributes := TStringList.Create;
  end;
  if LockedFilesStaleDir = '' then begin
    // One folder per update run; a suffix keeps runs within the same second apart.
    LockedFilesStaleDir := AddBackslash(LockedFilesStaleRoot(Root)) + GetDateTimeString('yyyymmddhhnnss', #0, #0);
    while DirExists(LockedFilesStaleDir) do
      LockedFilesStaleDir := LockedFilesStaleDir + '-';
  end;
  // Checked on every move: deleting earlier runs' files, after the tools were staged, also removes this run's folder.
  if not DirExists(LockedFilesStaleDir) then
    ForceDirectories(LockedFilesStaleDir);
  Target := AddBackslash(LockedFilesStaleDir) + IntToStr(LockedFilesMoved.Count);
  if LockedFilesMoveFile(ExtendedPath(Source), ExtendedPath(Target)) then begin
    LockedFilesMoved.Add(RelativePath);
    LockedFilesAttributes.Add(IntToStr(Attributes));
    // A read-only copy would keep a later update from deleting the stale folder.
    if Attributes and LockedFilesAttributeReadOnly <> 0 then
      LockedFilesSetAttributes(ExtendedPath(Target), LockedFilesAttributeNormal);
    Log('Moved a file inno_updater cannot delete out of the way: ' + Source + ' -> ' + Target);
  end else
    Log('A file inno_updater cannot delete could not be moved: ' + Source);
end;

// An antivirus may hold the previous inno_updater, which a background update replaces while it stages.
// Used as the BeforeInstall of the tools files.
procedure MoveToolAsideIfHeld();
var
  App, RelativePath: String;
  Attributes: Cardinal;
begin
  App := ExpandConstant('{app}');
  RelativePath := 'tools\' + ExtractFileName(ExpandConstant(CurrentFileName));
  Attributes := LockedFilesGetAttributes(ExtendedPath(AddBackslash(App) + RelativePath));
  if (Attributes <> LockedFilesInvalidAttributes) and UpdaterCannotDelete(AddBackslash(App) + RelativePath, Attributes) then
    MoveFileAside(App, RelativePath, Attributes);
end;

// The top-level entries inno_updater leaves in place: the staged update, its own tools, the uninstaller and the
// sparse package and bootstrap folders. Mirrors delete_existing_version in inno_updater 0.23.0.
function IsSkippedByUpdater(const Name: String): Boolean;
begin
  Result := (Name = '_') or (CompareText(Name, 'tools') = 0) or (CompareText(Copy(Name, 1, 5), 'unins') = 0)
    or (CompareText(Name, 'appx') = 0) or (CompareText(Name, 'bootstrap') = 0);
end;

// Moves every file under Root\RelativeDir that inno_updater could not delete out of its way. Links and junctions are
// left alone and never followed, so nothing outside the install folder is touched.
procedure MoveFilesAsideIn(const Root, RelativeDir: String);
var
  Find: TFindRec;
  RelativePath: String;
begin
  if not FindFirst(ExtendedPath(AddBackslash(AddBackslash(Root) + RelativeDir) + '*'), Find) then
    exit;
  try
    repeat
      if (Find.Name = '.') or (Find.Name = '..') or ((RelativeDir = '') and IsSkippedByUpdater(Find.Name))
        or (Find.Attributes and LockedFilesAttributeReparsePoint <> 0) then
        continue;
      if RelativeDir = '' then
        RelativePath := Find.Name
      else
        RelativePath := AddBackslash(RelativeDir) + Find.Name;
      if Find.Attributes and LockedFilesAttributeDirectory <> 0 then
        MoveFilesAsideIn(Root, RelativePath)
      else if UpdaterCannotDelete(AddBackslash(Root) + RelativePath, Find.Attributes) then
        MoveFileAside(Root, RelativePath, Find.Attributes);
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
    Target := ExtendedPath(AddBackslash(Root) + LockedFilesMoved[I]);
    if (LockedFilesGetAttributes(Target) = LockedFilesInvalidAttributes)
      and LockedFilesMoveFile(ExtendedPath(AddBackslash(LockedFilesStaleDir) + IntToStr(I)), Target) then begin
      LockedFilesSetAttributes(Target, StrToInt(LockedFilesAttributes[I]));
      Log('Restored a moved file: ' + AddBackslash(Root) + LockedFilesMoved[I]);
    end;
  end;
  LockedFilesMoved.Clear;
  LockedFilesAttributes.Clear;
end;

// Deletes what earlier updates moved aside; a file still held stays until a later update.
procedure DeleteStaleFiles(const Root: String);
begin
  if DirExists(LockedFilesStaleRoot(Root)) and not DelTree(LockedFilesStaleRoot(Root), True, True, True) then
    Log('Some files moved aside by an earlier update are still held and stay for a later update');
end;

// Runs inno_updater after moving the files it cannot delete out of its way. When it fails, the moved files go back,
// so the previous version still starts.
function RunUpdaterAroundHeldFiles(const Updater, ExePath, Params: String; var ResultCode: Integer): Boolean;
var
  Root: String;
  Placeholder: Boolean;
begin
  Root := ExtractFileDir(ExePath);
  DeleteStaleFiles(Root);
  MoveFilesAsideIn(Root, '');
  // inno_updater refuses to start without the executable; an empty file that it deletes like the rest stands in for it.
  Placeholder := False;
  if not FileExists(ExePath) then
    Placeholder := SaveStringToFile(ExePath, '', False);
  Result := Exec(Updater, Params, '', SW_SHOW, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if Result then
    // The moved files are no longer needed; those still held stay for a later update.
    DeleteStaleFiles(Root)
  else begin
    if Placeholder then
      DeleteFile(ExePath);
    RestoreMovedFiles(Root);
  end;
end;

// A failed earlier update leaves its staged files in {app}\_; a new background update stages into the same folder, and
// leftovers would be swapped in with it.
procedure DeleteStagedUpdate(const Root: String);
begin
  if DirExists(AddBackslash(Root) + '_') and not DelTree(AddBackslash(Root) + '_', True, True, True) then
    Log('Could not delete every file left in the staging folder by an earlier update');
end;
