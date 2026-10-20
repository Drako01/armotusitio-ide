# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.
# Register only the ArmotuSitio detector. This script never starts a build.
[CmdletBinding()]
param(
	[ValidateSet('Register', 'Enable', 'Disable', 'Remove', 'Status', 'Run')]
	[string]$Operation = 'Register',
	[ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
	[string]$At = '10:00',
	[switch]$PrepareCandidates
)

$ErrorActionPreference = 'Stop'
$taskName = 'ArmotuSitio IDE - Upstream'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scriptPath = Join-Path $repoRoot 'scripts\ats-autoupdate.mts'
$runnerPath = $PSCommandPath
if ($Operation -eq 'Run') {
	$statePath = Join-Path $repoRoot '.build\ats-autoupdate'
	New-Item -ItemType Directory -Force -Path $statePath | Out-Null
	$nodePath = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
	$nodeArguments = @($scriptPath, 'detect')
	if ($PrepareCandidates) { $nodeArguments += '--prepare' }
	& $nodePath @nodeArguments *> (Join-Path $statePath 'scheduled.log')
	exit $LASTEXITCODE
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions | Where-Object { $_.Arguments.Contains($scriptPath) -or $_.Arguments.Contains($runnerPath) })) {
	throw 'A task with this name belongs to another checkout. Inspect it before changing it.'
}
switch ($Operation) {
	'Register' {
		if ($existing) { throw 'Task already exists. Use Enable, Disable or Remove explicitly.' }
		$powerShell = (Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
		if (-not $powerShell) { $powerShell = (Get-Command powershell -CommandType Application -ErrorAction Stop).Source }
		$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $runnerPath + '" -Operation Run'
		if ($PrepareCandidates) { $arguments += ' -PrepareCandidates' }
		$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $repoRoot
		$trigger = New-ScheduledTaskTrigger -Daily -At $At
		$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
		$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
		$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Detect upstream releases without GitHub Actions. No builds or publication.'
		$task.Settings.Enabled = $false
		Register-ScheduledTask -TaskName $taskName -InputObject $task | Select-Object TaskName, State
	}
	'Enable' { Enable-ScheduledTask -TaskName $taskName | Select-Object TaskName, State }
	'Disable' { Disable-ScheduledTask -TaskName $taskName | Select-Object TaskName, State }
	'Remove' { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
	'Status' { $existing | Select-Object TaskName, State, Actions, Triggers }
}
