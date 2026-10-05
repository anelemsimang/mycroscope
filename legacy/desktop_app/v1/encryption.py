import base64
import json
import os
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from typing import Any, Dict, Optional

from config import ENCRYPTION_KEY


class DataEncryption:
    """Handles encryption and decryption of sensitive data."""
    
    def __init__(self, key: Optional[str] = None):
        self.key = key or ENCRYPTION_KEY
        self._fernet = None
        self._setup_encryption()
    
    def _setup_encryption(self):
        """Setup the encryption key and Fernet cipher."""
        # Generate a key from the password
        salt = b'mycroscope_salt_2024'  # In production, use a random salt
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=salt,
            iterations=100000,
        )
        key = base64.urlsafe_b64encode(kdf.derive(self.key.encode()))
        self._fernet = Fernet(key)
    
    def encrypt_data(self, data: Any) -> str:
        """Encrypt data and return base64 encoded string."""
        if isinstance(data, (dict, list)):
            data_str = json.dumps(data, ensure_ascii=False)
        else:
            data_str = str(data)
        
        encrypted_data = self._fernet.encrypt(data_str.encode('utf-8'))
        return base64.urlsafe_b64encode(encrypted_data).decode('utf-8')
    
    def decrypt_data(self, encrypted_data: str) -> Any:
        """Decrypt data and return original object."""
        try:
            encrypted_bytes = base64.urlsafe_b64decode(encrypted_data.encode('utf-8'))
            decrypted_data = self._fernet.decrypt(encrypted_bytes)
            data_str = decrypted_data.decode('utf-8')
            
            # Try to parse as JSON first
            try:
                return json.loads(data_str)
            except json.JSONDecodeError:
                return data_str
        except Exception as e:
            raise ValueError(f"Failed to decrypt data: {e}")
    
    def encrypt_file(self, file_path: str, data: Any) -> None:
        """Encrypt data and save to file."""
        encrypted_data = self.encrypt_data(data)
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(encrypted_data)
    
    def decrypt_file(self, file_path: str) -> Any:
        """Decrypt data from file."""
        with open(file_path, 'r', encoding='utf-8') as f:
            encrypted_data = f.read()
        return self.decrypt_data(encrypted_data)


class SecureStorage:
    """Secure storage for sensitive application data."""
    
    def __init__(self, storage_dir: str):
        self.storage_dir = storage_dir
        self.encryption = DataEncryption()
        os.makedirs(storage_dir, exist_ok=True)
    
    def store_employee_data(self, employee_id: str, data: Dict[str, Any]) -> None:
        """Store encrypted employee data."""
        file_path = os.path.join(self.storage_dir, f"employee_{employee_id}.enc")
        self.encryption.encrypt_file(file_path, data)
    
    def get_employee_data(self, employee_id: str) -> Dict[str, Any]:
        """Retrieve and decrypt employee data."""
        file_path = os.path.join(self.storage_dir, f"employee_{employee_id}.enc")
        if not os.path.exists(file_path):
            return {}
        
        try:
            return self.encryption.decrypt_file(file_path)
        except Exception:
            return {}
    
    def store_session_data(self, session_id: str, data: Dict[str, Any]) -> None:
        """Store encrypted session data."""
        file_path = os.path.join(self.storage_dir, f"session_{session_id}.enc")
        self.encryption.encrypt_file(file_path, data)
    
    def get_session_data(self, session_id: str) -> Dict[str, Any]:
        """Retrieve and decrypt session data."""
        file_path = os.path.join(self.storage_dir, f"session_{session_id}.enc")
        if not os.path.exists(file_path):
            return {}
        
        try:
            return self.encryption.decrypt_file(file_path)
        except Exception:
            return {}
    
    def clear_employee_data(self, employee_id: str) -> None:
        """Clear employee data."""
        file_path = os.path.join(self.storage_dir, f"employee_{employee_id}.enc")
        if os.path.exists(file_path):
            os.remove(file_path)
    
    def clear_session_data(self, session_id: str) -> None:
        """Clear session data."""
        file_path = os.path.join(self.storage_dir, f"session_{session_id}.enc")
        if os.path.exists(file_path):
            os.remove(file_path)


# Global encryption instance
encryption = DataEncryption()


def encrypt_data(data: Any) -> str:
    """Encrypt data using the global encryption instance."""
    return encryption.encrypt_data(data)


def decrypt_data(encrypted_data: str) -> Any:
    """Decrypt data using the global encryption instance."""
    return encryption.decrypt_data(encrypted_data) 
encryption = DataEncryption() 