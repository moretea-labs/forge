#[cfg(target_os = "macos")]
mod macos {
    use core_foundation_sys::{
        array::{kCFTypeArrayCallBacks, CFArrayCreate, CFArrayRef},
        base::{CFRelease, CFTypeRef, OSStatus},
        string::{kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringRef},
    };
    use security_framework::os::macos::keychain::SecKeychain;
    use security_framework::passwords::{generic_password, PasswordOptions};
    use security_framework_sys::{
        base::{
            errSecAuthFailed, errSecItemNotFound, errSecSuccess, SecAccessRef,
            SecKeychainAttribute, SecKeychainAttributeList, SecKeychainItemRef,
        },
        keychain::SecKeychainFindGenericPassword,
        keychain_item::{SecKeychainItemDelete, SecKeychainItemModifyAttributesAndData},
    };
    use std::{
        env,
        ffi::CString,
        os::raw::{c_char, c_void},
        path::{Path, PathBuf},
        ptr,
    };

    const SERVICE: &str = "com.moretea.forge.desktop.credential";
    const ERR_SEC_INTERACTION_NOT_ALLOWED: OSStatus = -25308;
    const GENERIC_PASSWORD_ITEM_CLASS: u32 = u32::from_be_bytes(*b"genp");
    const ACCOUNT_ITEM_ATTR: u32 = u32::from_be_bytes(*b"acct");
    const SERVICE_ITEM_ATTR: u32 = u32::from_be_bytes(*b"svce");

    fn is_untrusted_access(status: OSStatus) -> bool {
        status == ERR_SEC_INTERACTION_NOT_ALLOWED || status == errSecAuthFailed
    }

    type SecTrustedApplicationRef = *mut c_void;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecTrustedApplicationCreateFromPath(
            path: *const c_char,
            app: *mut SecTrustedApplicationRef,
        ) -> OSStatus;
        fn SecAccessCreate(
            descriptor: CFStringRef,
            trusted_list: CFArrayRef,
            access: *mut SecAccessRef,
        ) -> OSStatus;
        fn SecKeychainItemCreateFromContent(
            item_class: u32,
            attributes: *mut SecKeychainAttributeList,
            length: u32,
            data: *const c_void,
            keychain: *mut c_void,
            initial_access: SecAccessRef,
            item: *mut SecKeychainItemRef,
        ) -> OSStatus;
    }

    struct CfOwned(CFTypeRef);
    impl Drop for CfOwned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    struct KeychainItemOwned(SecKeychainItemRef);
    impl Drop for KeychainItemOwned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0.cast()) };
            }
        }
    }

    struct AccessOwned(SecAccessRef);
    impl Drop for AccessOwned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0.cast()) };
            }
        }
    }

    fn installed_helper_candidate() -> Option<PathBuf> {
        let current = env::current_exe().ok();
        if let Some(path) = current.as_ref() {
            if path.file_name().and_then(|value| value.to_str()) == Some("forge-desktop")
                && path.parent().and_then(Path::file_name).and_then(|value| value.to_str()) == Some("MacOS")
                && path.parent().and_then(Path::parent).and_then(Path::file_name)
                    .and_then(|value| value.to_str()) == Some("Contents")
                && path.parent().and_then(Path::parent).and_then(Path::parent)
                    .and_then(Path::file_name).and_then(|value| value.to_str()) == Some("Forge.app")
            {
                return Some(path.clone());
            }
        }
        dirs::home_dir()
            .map(|home| home.join("Applications/Forge.app/Contents/MacOS/forge-desktop"))
            .filter(|path| path.is_file())
    }

    fn trusted_helper_path() -> Result<PathBuf, String> {
        installed_helper_candidate()
            .ok_or_else(|| "FORGE_DESKTOP_CREDENTIAL_TRUSTED_HELPER_UNAVAILABLE".to_string())
    }

    unsafe fn create_access(helper: &Path) -> Result<AccessOwned, String> {
        let path = CString::new(helper.as_os_str().to_string_lossy().as_bytes())
            .map_err(|_| "FORGE_DESKTOP_CREDENTIAL_TRUSTED_HELPER_INVALID")?;
        let mut trusted: SecTrustedApplicationRef = ptr::null_mut();
        let status = SecTrustedApplicationCreateFromPath(path.as_ptr(), &mut trusted);
        if status != errSecSuccess || trusted.is_null() {
            return Err("FORGE_DESKTOP_CREDENTIAL_TRUSTED_HELPER_INVALID".into());
        }
        let trusted_owned = CfOwned(trusted.cast());

        let values = [trusted.cast_const()];
        let trusted_list = CFArrayCreate(
            ptr::null(),
            values.as_ptr(),
            values.len() as isize,
            &kCFTypeArrayCallBacks,
        );
        if trusted_list.is_null() {
            return Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_CREATE_FAILED".into());
        }
        let list_owned = CfOwned(trusted_list.cast());

        let label = CString::new("Forge managed API credential").expect("static keychain label");
        let descriptor = CFStringCreateWithCString(
            ptr::null(),
            label.as_ptr(),
            kCFStringEncodingUTF8,
        );
        if descriptor.is_null() {
            return Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_CREATE_FAILED".into());
        }
        let descriptor_owned = CfOwned(descriptor.cast());

        let mut access: SecAccessRef = ptr::null_mut();
        let status = SecAccessCreate(descriptor, trusted_list, &mut access);
        drop(descriptor_owned);
        drop(list_owned);
        drop(trusted_owned);
        if status != errSecSuccess || access.is_null() {
            return Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_CREATE_FAILED".into());
        }
        Ok(AccessOwned(access))
    }

    unsafe fn find_item(account: &str) -> Result<Option<KeychainItemOwned>, String> {
        let mut item: SecKeychainItemRef = ptr::null_mut();
        let status = SecKeychainFindGenericPassword(
            ptr::null(),
            SERVICE.len() as u32,
            SERVICE.as_ptr().cast(),
            account.len() as u32,
            account.as_ptr().cast(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut item,
        );
        if status == errSecItemNotFound {
            return Ok(None);
        }
        if status != errSecSuccess || item.is_null() {
            if is_untrusted_access(status) {
                return Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_NOT_TRUSTED".into());
            }
            return Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_LOOKUP_FAILED".into());
        }
        Ok(Some(KeychainItemOwned(item)))
    }

    pub fn read(account: &str) -> Result<Option<String>, String> {
        let _interaction = SecKeychain::disable_user_interaction()
            .map_err(|_| "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_INTERACTION_CONTROL_FAILED")?;
        match generic_password(PasswordOptions::new_generic_password(SERVICE, account)) {
            Ok(value) => String::from_utf8(value)
                .map(Some)
                .map_err(|_| "FORGE_DESKTOP_CREDENTIAL_SECRET_INVALID".to_string()),
            Err(error) if error.code() == errSecItemNotFound => Ok(None),
            Err(error) if is_untrusted_access(error.code()) => {
                Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_NOT_TRUSTED".into())
            }
            Err(_) => Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_READ_FAILED".into()),
        }
    }

    pub fn write(account: &str, secret: &str) -> Result<(), String> {
        let helper = trusted_helper_path()?;
        let _interaction = SecKeychain::disable_user_interaction()
            .map_err(|_| "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_INTERACTION_CONTROL_FAILED")?;

        unsafe {
            let access = create_access(&helper)?;
            if let Some(item) = find_item(account)? {
                let status = SecKeychainItemModifyAttributesAndData(
                    item.0,
                    ptr::null(),
                    secret.len() as u32,
                    secret.as_ptr().cast(),
                );
                if status != errSecSuccess {
                    return Err(if is_untrusted_access(status) {
                        "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_NOT_TRUSTED"
                    } else {
                        "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_WRITE_FAILED"
                    }.into());
                }
                return Ok(());
            }

            let mut attributes = [
                SecKeychainAttribute {
                    tag: SERVICE_ITEM_ATTR,
                    length: SERVICE.len() as u32,
                    data: SERVICE.as_ptr().cast_mut().cast(),
                },
                SecKeychainAttribute {
                    tag: ACCOUNT_ITEM_ATTR,
                    length: account.len() as u32,
                    data: account.as_ptr().cast_mut().cast(),
                },
            ];
            let mut attribute_list = SecKeychainAttributeList {
                count: attributes.len() as u32,
                attr: attributes.as_mut_ptr(),
            };
            let mut item: SecKeychainItemRef = ptr::null_mut();
            let status = SecKeychainItemCreateFromContent(
                GENERIC_PASSWORD_ITEM_CLASS,
                &mut attribute_list,
                secret.len() as u32,
                secret.as_ptr().cast(),
                ptr::null_mut(),
                access.0,
                &mut item,
            );
            if status != errSecSuccess || item.is_null() {
                return Err(if is_untrusted_access(status) {
                    "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_NOT_TRUSTED"
                } else {
                    "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_WRITE_FAILED"
                }.into());
            }
            drop(KeychainItemOwned(item));
            Ok(())
        }
    }

    pub fn delete(account: &str) -> Result<(), String> {
        let _interaction = SecKeychain::disable_user_interaction()
            .map_err(|_| "FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_INTERACTION_CONTROL_FAILED")?;
        unsafe {
            let Some(item) = find_item(account)? else { return Ok(()); };
            let status = SecKeychainItemDelete(item.0);
            if status == errSecSuccess || status == errSecItemNotFound {
                return Ok(());
            }
            if is_untrusted_access(status) {
                return Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_ACCESS_NOT_TRUSTED".into());
            }
            Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_DELETE_FAILED".into())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn installed_helper_candidate_is_never_an_arbitrary_binary() {
            if let Some(path) = installed_helper_candidate() {
                let text = path.to_string_lossy();
                assert!(text.ends_with("/Forge.app/Contents/MacOS/forge-desktop"));
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    pub fn read(_account: &str) -> Result<Option<String>, String> {
        Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_UNSUPPORTED".into())
    }
    pub fn write(_account: &str, _secret: &str) -> Result<(), String> {
        Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_UNSUPPORTED".into())
    }
    pub fn delete(_account: &str) -> Result<(), String> {
        Err("FORGE_DESKTOP_CREDENTIAL_KEYCHAIN_UNSUPPORTED".into())
    }
}

pub use macos::{delete, read, write};
