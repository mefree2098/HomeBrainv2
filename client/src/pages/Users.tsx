import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { useToast } from "@/hooks/useToast";
import { createUser, deleteUser, getUsers, resetUserPassword, updateUser } from "@/api/users";
import { useAuth } from "@/contexts/AuthContext";
import {
  DEFAULT_USER_PLATFORMS,
  isAdminRole,
  normalizeUserPlatforms,
  type User,
  type UserPlatforms,
  type UserRole
} from "../../../shared/types/user";
import { KeyRound, Pencil, ShieldCheck, Trash2, UserPlus } from "lucide-react";

type UserFormState = {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  isActive: boolean;
  platforms: UserPlatforms;
}

const DEFAULT_FORM_STATE: UserFormState = {
  name: "",
  email: "",
  password: "",
  role: "user",
  isActive: true,
  platforms: DEFAULT_USER_PLATFORMS
};

const buildDefaultFormState = (): UserFormState => ({
  ...DEFAULT_FORM_STATE,
  platforms: { ...DEFAULT_USER_PLATFORMS }
});

const formatDateTime = (value?: string | null) => {
  if (!value) {
    return "Never";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Never";
  }

  return parsed.toLocaleString();
};

export function Users() {
  const { toast } = useToast();
  const { currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [isUserDialogOpen, setIsUserDialogOpen] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [passwordTargetUser, setPasswordTargetUser] = useState<User | null>(null);
  const [formState, setFormState] = useState<UserFormState>(() => buildDefaultFormState());
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);

  const currentUserId = currentUser?._id ?? null;

  const fetchUsers = async () => {
    try {
      const nextUsers = await getUsers();
      setUsers(nextUsers);
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to load users.";
      toast({
        title: "Unable to load users",
        description,
        variant: "destructive"
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchUsers();
  }, []);

  const filteredUsers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return users;
    }

    return users.filter((user) => {
      return [
        user.name || "",
        user.email || "",
        user.role || "",
        normalizeUserPlatforms(user.platforms).homebrain ? "homebrain" : "",
        normalizeUserPlatforms(user.platforms).axiom ? "axiom" : ""
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [searchQuery, users]);

  const stats = useMemo(() => {
    const admins = users.filter((user) => isAdminRole(user.role)).length;
    const active = users.filter((user) => user.isActive).length;
    return {
      total: users.length,
      admins,
      users: users.length - admins,
      active,
      inactive: users.length - active
    };
  }, [users]);

  const updateForm = <K extends keyof UserFormState>(key: K, value: UserFormState[K]) => {
    setFormState((prev) => ({
      ...prev,
      [key]: value
    }));
  };

  const openCreateDialog = () => {
    setEditingUser(null);
    setFormState(buildDefaultFormState());
    setIsUserDialogOpen(true);
  };

  const openEditDialog = (user: User) => {
    setEditingUser(user);
    setFormState({
      name: user.name || "",
      email: user.email,
      password: "",
      role: user.role,
      isActive: user.isActive,
      platforms: normalizeUserPlatforms(user.platforms)
    });
    setIsUserDialogOpen(true);
  };

  const closeUserDialog = () => {
    setEditingUser(null);
    setFormState(buildDefaultFormState());
    setIsUserDialogOpen(false);
  };

  const handleSaveUser = async () => {
    if (!formState.email.trim()) {
      toast({
        title: "Email required",
        description: "Enter an email address for this user.",
        variant: "destructive"
      });
      return;
    }

    if (!editingUser && !formState.password.trim()) {
      toast({
        title: "Password required",
        description: "New users need an initial password.",
        variant: "destructive"
      });
      return;
    }

    setSaving(true);
    try {
      if (editingUser) {
        const response = await updateUser(editingUser._id, {
          name: formState.name.trim(),
          email: formState.email.trim(),
          role: formState.role,
          isActive: formState.isActive,
          platforms: formState.platforms
        });

        setUsers((prev) => prev.map((user) => (
          user._id === editingUser._id ? response.user : user
        )));

        toast({
          title: "User updated",
          description: response.message
        });
      } else {
        const response = await createUser({
          name: formState.name.trim(),
          email: formState.email.trim(),
          password: formState.password,
          role: formState.role,
          isActive: formState.isActive,
          platforms: formState.platforms
        });

        setUsers((prev) => [...prev, response.user]);
        toast({
          title: "User created",
          description: response.message
        });
      }

      closeUserDialog();
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to save user.";
      toast({
        title: "Save failed",
        description,
        variant: "destructive"
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (user: User, nextActive: boolean) => {
    if (user._id === currentUserId) {
      toast({
        title: "Action blocked",
        description: "Use another admin account to deactivate your current session.",
        variant: "destructive"
      });
      return;
    }

    try {
      const response = await updateUser(user._id, { isActive: nextActive });
      setUsers((prev) => prev.map((entry) => (
        entry._id === user._id ? response.user : entry
      )));
      toast({
        title: nextActive ? "User activated" : "User deactivated",
        description: response.message
      });
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to update user status.";
      toast({
        title: "Status update failed",
        description,
        variant: "destructive"
      });
    }
  };

  const handleDeleteUser = async (user: User) => {
    if (user._id === currentUserId) {
      toast({
        title: "Action blocked",
        description: "You cannot delete the account you are currently using.",
        variant: "destructive"
      });
      return;
    }

    const confirmed = window.confirm(`Delete ${user.email}? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    try {
      const response = await deleteUser(user._id);
      setUsers((prev) => prev.filter((entry) => entry._id !== user._id));
      toast({
        title: "User deleted",
        description: response.message
      });
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to delete user.";
      toast({
        title: "Delete failed",
        description,
        variant: "destructive"
      });
    }
  };

  const openPasswordDialog = (user: User) => {
    setPasswordTargetUser(user);
    setNewPassword("");
    setConfirmPassword("");
    setIsPasswordDialogOpen(true);
  };

  const closePasswordDialog = () => {
    setPasswordTargetUser(null);
    setNewPassword("");
    setConfirmPassword("");
    setIsPasswordDialogOpen(false);
  };

  const handleResetPassword = async () => {
    if (!passwordTargetUser) {
      return;
    }

    if (!newPassword.trim()) {
      toast({
        title: "Password required",
        description: "Enter a new password before saving.",
        variant: "destructive"
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: "Passwords do not match",
        description: "Enter the same password twice.",
        variant: "destructive"
      });
      return;
    }

    setResettingPassword(true);
    try {
      const response = await resetUserPassword(passwordTargetUser._id, newPassword);
      toast({
        title: "Password reset",
        description: response.message
      });
      closePasswordDialog();
    } catch (error) {
      const description = error instanceof Error ? error.message : "Failed to reset password.";
      toast({
        title: "Reset failed",
        description,
        variant: "destructive"
      });
    } finally {
      setResettingPassword(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Users</h1>
          <p className="mt-1 text-muted-foreground">
            Manage HomeBrain accounts, assign admin or user access, and disable accounts without deleting history.
          </p>
        </div>
        <div className="flex gap-2">
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search users"
            className="w-full min-w-[14rem] lg:w-64"
          />
          <Button onClick={openCreateDialog}>
            <UserPlus className="mr-2 h-4 w-4" />
            New User
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Total Accounts</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.total}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Admins</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.admins}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Standard Users</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.users}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Inactive</CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-semibold">{stats.inactive}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Access Directory
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Platforms</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Login</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[18rem]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.map((user) => {
                const isSelf = user._id === currentUserId;
                const platforms = normalizeUserPlatforms(user.platforms);

                return (
                  <TableRow key={user._id}>
                    <TableCell>
                      <div className="font-medium text-foreground">{user.name || "Unnamed User"}</div>
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={isAdminRole(user.role) ? "default" : "secondary"}>
                        {isAdminRole(user.role) ? "Admin" : "User"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {platforms.homebrain ? (
                          <Badge variant="secondary">HomeBrain</Badge>
                        ) : null}
                        {platforms.axiom ? (
                          <Badge variant="secondary">Axiom</Badge>
                        ) : null}
                        {!platforms.homebrain && !platforms.axiom ? (
                          <Badge variant="outline">No Platforms</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={user.isActive}
                          disabled={isSelf}
                          onCheckedChange={(checked) => void handleToggleActive(user, checked)}
                        />
                        <Badge variant={user.isActive ? "secondary" : "outline"}>
                          {user.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(user.lastLoginAt)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDateTime(user.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => openEditDialog(user)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => openPasswordDialog(user)}>
                          <KeyRound className="mr-2 h-4 w-4" />
                          Password
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={isSelf}
                          onClick={() => void handleDeleteUser(user)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {filteredUsers.length === 0 ? (
            <div className="rounded-[1.5rem] border border-dashed border-border/70 px-6 py-12 text-center text-sm text-muted-foreground">
              No users matched your current search.
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={isUserDialogOpen} onOpenChange={(open) => {
        if (!open) {
          closeUserDialog();
          return;
        }
        setIsUserDialogOpen(true);
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editingUser ? "Edit User" : "Create User"}</DialogTitle>
            <DialogDescription>
              {editingUser
                ? "Update account details, platform access, and role assignments for this user."
                : "Create a new user account, choose the allowed platforms, and decide whether it should have admin access."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Display Name</label>
              <Input
                value={formState.name}
                onChange={(event) => updateForm("name", event.target.value)}
                placeholder="Alex"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <Input
                type="email"
                value={formState.email}
                onChange={(event) => updateForm("email", event.target.value)}
                placeholder="alex@example.com"
              />
            </div>
            {!editingUser ? (
              <div className="space-y-2">
                <label className="text-sm font-medium">Initial Password</label>
                <Input
                  type="password"
                  value={formState.password}
                  onChange={(event) => updateForm("password", event.target.value)}
                  placeholder="Create a password"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <label className="text-sm font-medium">Role</label>
              <Select
                value={formState.role}
                onValueChange={(value) => updateForm("role", value as UserRole)}
                disabled={editingUser?._id === currentUserId}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="rounded-[1.25rem] border border-border/70 px-4 py-4">
            <div className="mb-3">
              <div className="text-sm font-medium text-foreground">Platform Access</div>
              <div className="text-xs text-muted-foreground">
                Users can only access the platforms checked here. Admin applies only within the enabled platforms.
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label htmlFor="platform-homebrain" className="flex items-start gap-3 rounded-[1rem] border border-border/70 px-4 py-3">
                <Checkbox
                  id="platform-homebrain"
                  checked={formState.platforms.homebrain}
                  disabled={editingUser?._id === currentUserId}
                  onCheckedChange={(checked) => updateForm("platforms", {
                    ...formState.platforms,
                    homebrain: Boolean(checked)
                  })}
                />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">HomeBrain</div>
                  <p className="text-xs text-muted-foreground">
                    Required to access the HomeBrain dashboard, APIs, and admin tools.
                  </p>
                </div>
              </label>
              <label htmlFor="platform-axiom" className="flex items-start gap-3 rounded-[1rem] border border-border/70 px-4 py-3">
                <Checkbox
                  id="platform-axiom"
                  checked={formState.platforms.axiom}
                  onCheckedChange={(checked) => updateForm("platforms", {
                    ...formState.platforms,
                    axiom: Boolean(checked)
                  })}
                />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">Axiom</div>
                  <p className="text-xs text-muted-foreground">
                    Required for Axiom sign-in through HomeBrain SSO.
                  </p>
                </div>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-[1.25rem] border border-border/70 px-4 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">Account Active</div>
              <div className="text-xs text-muted-foreground">
                Inactive users can no longer log in or refresh existing sessions.
              </div>
            </div>
            <Switch
              checked={formState.isActive}
              disabled={editingUser?._id === currentUserId}
              onCheckedChange={(checked) => updateForm("isActive", checked)}
            />
          </div>

          {editingUser?._id === currentUserId ? (
            <div className="rounded-[1.25rem] border border-border/70 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Your current session cannot demote itself, deactivate itself, or remove its own HomeBrain access. Use another admin account for that.
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={closeUserDialog}>Cancel</Button>
            <Button onClick={() => void handleSaveUser()} disabled={saving}>
              {saving ? "Saving..." : editingUser ? "Save Changes" : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isPasswordDialogOpen} onOpenChange={(open) => {
        if (!open) {
          closePasswordDialog();
          return;
        }
        setIsPasswordDialogOpen(true);
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              {passwordTargetUser ? `Set a new password for ${passwordTargetUser.email}.` : "Set a new password."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">New Password</label>
              <Input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="Enter a new password"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Confirm Password</label>
              <Input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Re-enter the new password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePasswordDialog}>Cancel</Button>
            <Button onClick={() => void handleResetPassword()} disabled={resettingPassword}>
              {resettingPassword ? "Saving..." : "Reset Password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
