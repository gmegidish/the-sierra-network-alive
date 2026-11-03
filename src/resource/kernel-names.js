// LSCI kernel function names, in kernel-number order.
// Extracted from the far-pointer name table in LSCITV.EXE (after LZEXE 0.91
// unpacking; table at image offset 0x1d350, 89 entries). Numbering confirmed
// against bytecode (e.g. Obj::new does `callk 2` = ObjectNew).
// Many names are shared with stock SCI, but the numbering is LSCI-specific and
// several calls (Array, Block, Seq, String, ModuleID, TSN, ...) do not exist in SCI1.

export const KERNEL_NAMES = Object.freeze([
  'IsObject', 'ObjectFree', 'ObjectNew', 'ObjectRespondsTo', 'Array', 'Block', 'List',
  'ModuleDispose', 'ModuleID', 'Resource', 'Seq', 'String', 'GetFarText', 'CoordPri',
  'DrawPic', 'PicState', 'ShakeScreen', 'Show', 'AddToPic', 'Animate', 'CelHigh', 'CelRect',
  'CelWide', 'DrawCel', 'DrawScaledCel', 'NumCels', 'NumLoops', 'ScaledCelRect', 'DrawControl',
  'EditControl', 'HiliteControl', 'GetPort', 'SetPort', 'WindowDispose', 'WindowNew', 'Display',
  'TextSize', 'GetEvent', 'GlobalToLocal', 'LocalToGlobal', 'MapKeyToDir', 'Menu', 'HaveMouse',
  'SetCursor', 'Memory', 'CheckSaveGame', 'GameIsRestarting', 'GetSaveDir', 'GetSaveFiles',
  'Restart', 'Restore', 'Save', 'Sound', 'GetTime', 'SetTimerFreq', 'Wait', 'Alert', 'CanBeHere',
  'OnControl', 'FileSystem', 'DeviceInfo', 'Abs', 'CosDiv', 'CosMult', 'GetAngle', 'GetDistance',
  'Random', 'SinDiv', 'SinMult', 'Sqrt', 'Long', 'Graph', 'Debug', 'Profiler', 'SetDebug',
  'ShowFree', 'StackUsage', 'Joystick', 'BaseRectSet', 'ConfigStr', 'Encrypt', 'Decrypt',
  'ColorUp', 'ColorDown', 'TSN', 'ObjPropOffset', 'ObjOffsetProp', 'SID', 'InvokeMethod',
]);
